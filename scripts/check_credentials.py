#!/usr/bin/env python3
"""Refuse to commit anything that looks like a live credential.

Run by pre-commit over the staged files. It is a tripwire, not a guarantee:
a determined mistake will still get through, and the point is to catch the
careless one. Nothing here replaces rotating a key you think you have leaked.

Usage:
    python scripts/check_credentials.py FILE [FILE ...]
    python scripts/check_credentials.py --files0-from LIST
    python scripts/check_credentials.py --self-test

``--files0-from`` reads NUL-separated file names from LIST, or from standard
input when LIST is ``-``, so a file list of any length fits.

Exit status is 0 only when every file given was opened and none looked like a
credential. It is 1 when something was found or a file could not be read, and 2
when no file was given, not one of them could be opened, or the scanner itself
failed -- because a scanner that exits 0 having read nothing reports an
unexamined tree as a clean one, and a crash is not a finding.

Mark a genuine false positive with a trailing ``pragma: allowlist secret``
comment on the offending line. Do that sparingly and never to silence a real
key you intend to rotate later.
"""

from __future__ import annotations

import logging
import os
import re
import sys
from dataclasses import dataclass, field
from pathlib import Path

# Any copy of this scanner would flag itself: it contains the patterns it looks
# for and a self-test full of specimen keys. Matching on the filename rather
# than on this file's own resolved path matters because the canonical copy lives
# in ~/bin and is vendored into each repository, so `check_credentials.py` in a
# repo is a different file from the one doing the scanning.
SELF_NAME = "check_credentials.py"
# A copy read out of git history arrives under its blob hash, so the filename
# check cannot fire there. This marker travels with the content instead.
SELF_MARKER = "credential-guard:scanner-source"  # credential-guard:scanner-source

ALLOW_PRAGMA = re.compile(r"pragma:\s*allowlist\s+secret", re.IGNORECASE)

# Values that look like credentials and are not. Checked against the captured
# secret, so a placeholder in an example file stays committable.
PLACEHOLDER = re.compile(
    r"""^(
        | \s*
        | x{3,}
        | \.{3,}
        | <[^>]*>                       # <REDACTED>, <your-key-here>
        | \$\{?[A-Za-z_][A-Za-z0-9_]*\}?  # $VAR / ${VAR}
        | .*(example|sample|placeholder|dummy|fake|test|changeme|redacted).*
        | .*your[-_].*                  # your-api-key
        | 0{4,} | 1{4,} | a{4,} | x{4,}  # filler runs
    )$""",
    re.IGNORECASE | re.VERBOSE,
)

# Provider-issued formats. These are worth matching literally because each one
# is unambiguous: a string in this shape is a key, wherever it appears.
ISSUED = [
    ("Anthropic API key", re.compile(r"sk-ant-[A-Za-z0-9_\-]{20,}")),
    ("OpenAI API key", re.compile(r"\bsk-[A-Za-z0-9]{32,}")),
    ("OpenAI project key", re.compile(r"\bsk-(?:proj|svcacct|admin)-[A-Za-z0-9_\-]{20,}")),
    ("GitHub token", re.compile(r"\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36,}")),
    ("GitHub fine-grained token", re.compile(r"\bgithub_pat_[A-Za-z0-9_]{60,}")),
    ("GitLab token", re.compile(r"\bgl(?:pat|dt|rt|cbt|ptt)-[A-Za-z0-9_\-]{20,}")),
    ("AWS access key id", re.compile(r"\b(?:AKIA|ASIA)[0-9A-Z]{16}\b")),
    ("Azure storage account key", re.compile(r"\bAccountKey=[A-Za-z0-9+/]{80,}={0,2}")),
    ("Google API key", re.compile(r"\bAIza[0-9A-Za-z_\-]{35}\b")),
    ("Google OAuth client secret", re.compile(r"\bGOCSPX-[A-Za-z0-9_\-]{28}\b")),
    ("New Relic API key", re.compile(r"\bNR(?:AK|AA|II|IQ)-[A-Za-z0-9_\-]{20,}")),
    ("New Relic license key", re.compile(r"\b[0-9A-Za-z]{36}NRAL\b")),
    ("Slack token", re.compile(r"\bxox[abprs]-[0-9A-Za-z\-]{10,}")),
    (
        "Slack webhook URL",
        re.compile(
            r"hooks\.slack\.com/(?:services|workflows|triggers)/"
            r"T[A-Z0-9]+/[A-Za-z0-9]+/[A-Za-z0-9]{16,}"
        ),
    ),
    (
        "Discord webhook URL",
        re.compile(r"discord(?:app)?\.com/api/webhooks/\d+/[A-Za-z0-9_\-]{50,}"),
    ),
    ("Telegram bot token", re.compile(r"\b\d{8,10}:AA[A-Za-z0-9_\-]{33}\b")),
    ("Atlassian API token", re.compile(r"\bATATT3[A-Za-z0-9_\-=]{50,}")),
    ("Bitbucket app password", re.compile(r"\bATBB[A-Za-z0-9]{28,}")),
    ("Stripe live key", re.compile(r"\b(?:sk|rk)_live_[0-9A-Za-z]{16,}")),
    ("Shopify access token", re.compile(r"\bshp(?:at|ss|ca|pa)_[a-fA-F0-9]{32}\b")),
    ("Twilio account SID", re.compile(r"\bAC[0-9a-fA-F]{32}\b")),
    ("Twilio API key SID", re.compile(r"\bSK[0-9a-fA-F]{32}\b")),
    ("SendGrid API key", re.compile(r"\bSG\.[A-Za-z0-9_\-]{20,}\.[A-Za-z0-9_\-]{20,}")),
    ("Mailgun API key", re.compile(r"(?<![\w\-])key-[0-9a-f]{32}\b")),
    ("npm token", re.compile(r"\bnpm_[A-Za-z0-9]{36}\b")),
    ("npm registry auth token", re.compile(r"_authToken=(?![$<{])[A-Za-z0-9_\-+/=]{20,}")),
    ("PyPI token", re.compile(r"\bpypi-AgEIcHlwaS5vcmc[A-Za-z0-9_\-]{50,}")),
    ("Docker Hub token", re.compile(r"\bdckr_pat_[A-Za-z0-9_\-]{20,}")),
    ("Hugging Face token", re.compile(r"\bhf_[A-Za-z0-9]{34,}\b")),
    ("private key block", re.compile(r"-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY(?: BLOCK)?-----")),
    ("PuTTY private key", re.compile(r"^PuTTY-User-Key-File-\d+:")),
    ("PostgreSQL URL with password", re.compile(r"\bpostgres(?:ql)?://[^:\s/]+:[^@\s]+@")),
    ("generic URL with password", re.compile(r"\b[a-z][a-z0-9+.\-]*://[^:\s/]+:[^@\s]{6,}@")),
]

# A credential-shaped *name* assigned a long literal. The name half is the
# reason this catches things the issued-format list cannot: a bare 40-character
# vendor token has no prefix to recognise, but `api_key = "…"` names itself.
#
# `[A-Za-z0-9_]*` rather than a `\b`-anchored word: this repo shipped a scanner
# whose `\b` did not match beside an underscore, so `aws_secret_access_key = …`
# passed it. Underscores are word characters; `\bsecret\b` cannot see one that
# has a word character on both sides.
_WORDS = (
    r"api_?key|access_?key|license_?key|install_?key"
    r"|secret|token|passwd|password|auth|credential"
)
SECRET_NAME = rf"[A-Za-z0-9_.\-]*(?:{_WORDS})[A-Za-z0-9_.\-]*"

ASSIGNED = [
    # api_key = "…"  /  "api_key": "…"  /  api_key: "…"  /  'api_key' => '…'
    (
        "credential assigned a literal",
        re.compile(rf"""(?i)\b{SECRET_NAME}["']?\s*(?:=>|[:=])\s*["']([^"'\n]{{12,}})["']"""),
    ),
    # <api_key>…</api_key>, as in a Magento module's etc/config.xml defaults.
    (
        "credential in an XML element",
        re.compile(rf"""(?i)<{SECRET_NAME}(?:\s[^<>]*)?>([^<\n]{{12,}})</{SECRET_NAME}\s*>"""),
    ),
    # os.environ.get("API_KEY", "…") — a fallback default is a committed secret.
    # This is the exact shape that sat in this project's own first commit.
    (
        "credential as an environment fallback",
        re.compile(
            rf"""(?i)(?:environ(?:\.get)?|getenv)\s*\(\s*["']{SECRET_NAME}["']\s*,\s*"""
            r"""["']([^"'\n]{8,})["']"""
        ),
    ),
    # NEW_RELIC_API_KEY=… unquoted, anywhere on a line: inside a pasted command,
    # a Dockerfile RUN, a Markdown note. Upper-case names only, and the credential
    # word must be a whole underscore-separated part, so `max_tokens=…` and
    # `TOKENIZER=…` are left alone.
    (
        "credential assigned unquoted",
        re.compile(
            r"""(?<![A-Za-z0-9_$.\-])(?:[A-Z0-9]+_)*"""
            r"""(?:API_?KEY|ACCESS_?KEY|LICENSE_?KEY|INSTALL_?KEY"""
            r"""|SECRET|TOKEN|PASSWORD|PASSWD|PASS|CREDENTIALS?)"""
            r"""(?:_[A-Z0-9]+)*"""
            r"""(?<!_ID)(?<!_REF)(?<!_ARN)(?<!_URL)(?<!_URI)"""
            r"""(?<!_FILE)(?<!_PATH)(?<!_NAME)(?<!_TYPE)"""
            r"""=(?![=\s"'$<{%])([^\s"'`;&|<>(){}\[\],]{12,})"""
        ),
    ),
    # --password=… on a command line. The credential word must be a whole
    # hyphen-separated part, so `--passthrough=` is not one.
    (
        "credential passed as a flag",
        re.compile(
            r"""(?i)(?<![\w\-])--(?:[a-z0-9]+-)*"""
            r"""(?:password|passwd|pass|token|api-?key|access-?key|license-?key|secret)"""
            r"""(?:-[a-z0-9]+)*=(?![=\s"'$<{%])([^\s"'`;&|<>(){}\[\],]{8,})"""
        ),
    ),
]

# password: … in YAML, unquoted. The quoted form is already caught above; a
# value opening with a tag, anchor, block marker or template is not a literal.
YAML_LINE = (
    "credential in a YAML value",
    re.compile(
        rf"""(?im)^\s*(?:-\s+)?["']?{SECRET_NAME}["']?\s*:\s+"""
        r"""(?![\s"'#&*!|>{\[%$<])([^\s#]{12,})\s*$"""
    ),
)
YAML_FILES = re.compile(r"(?i)\.ya?ml$")

# API_KEY=… in a .env or shell file, unquoted. Restricted to config-shaped files:
# in Python the same shape is ordinary code, and `max_tokens=self.settings.
# agent_max_tokens` is not a secret.
CONFIG_LINE = (
    "credential assigned in a config line",
    re.compile(rf"""(?im)^\s*(?:export\s+)?{SECRET_NAME}\s*=\s*([^\s"'#]{{12,}})\s*$"""),
)
CONFIG_FILES = re.compile(
    r"""(?ix)(^|/)(
        \.env.*
      | .*\.(sh|bash|zsh|env|cfg|ini|conf|properties|toml|npmrc|pypirc)
      | Dockerfile.*
    )$"""
)

# Files that should never be committed at all, whatever is inside them.
FORBIDDEN_NAMES = re.compile(
    r"""(?ix)
    (^|/)(
        \.env(\.[A-Za-z0-9_\-]+)?      # .env, .env.local — but see the exception below
      | .*\.(pem|key|p12|pfx|keystore|jks)
      | .*\.(db|sqlite|sqlite3)        # a local database holds whatever the app stored
      | id_(rsa|dsa|ecdsa|ed25519)
      | credentials(\.json)?
      | \.git-credentials | \.netrc | \.pgpass | \.htpasswd
      | service[-_]account.*\.json
    )$""",
)
FORBIDDEN_EXCEPTIONS = re.compile(r"(^|/)\.env\.(example|sample|template)$")

# Files are streamed line by line, so the only reason for a ceiling is to avoid
# spending minutes on something that cannot usefully be read. A file above it is
# REPORTED rather than skipped: a security check that silently declines to look
# is worse than no check, because it still prints "Passed".
MAX_BYTES = 20_000_000


# A credential-shaped *name* is not enough: `TOKEN_FILENAME = "google-token.json"`
# and `tokenize = 'unicode61 remove_diacritics 2'` both have one. The value has to
# look like a secret as well — no prose, no path, no expression.
NOT_SECRET_VALUE = re.compile(
    r"""(?ix)
    ^(
        .*\s.*                                   # prose: a secret has no spaces
      | .*[()\[\]{}].*                            # an expression or f-string
      | [A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)+   # dotted.attribute.path
      | \\?[A-Za-z_][A-Za-z0-9_]*(\\[A-Za-z_][A-Za-z0-9_]*)+  # Vendor\Php\ClassName
      # config/path, /abs/path, Vendor_Module/asset
      | (?-i:(/?[a-z][a-z0-9_.\-]*|[A-Z][A-Za-z0-9]*_[A-Z][A-Za-z0-9]*)(/[a-z0-9_.\-]+)+)
      | \d{4}-?\d{2}-?\d{2}(T?\d{2}:?\d{2}(:?\d{2}(\.\d+)?)?)?(Z|[+\-]\d{2}:?\d{2})?  # a timestamp
      | \#[A-Za-z][\w\-]*(,\#[A-Za-z][\w\-]*)+    # a CSS selector list
      # Magento ciphertext, key:cipher[:iv]:base64
      | \d+:[0-3]:([A-Za-z0-9+/=]+:)?[A-Za-z0-9+/\\]+={0,2}
      | .*\.(json|txt|py|md|ya?ml|toml|cfg|ini|db|log|pem)  # a filename
      | https?://.*
    )$"""
)

# A lowercase identifier with a credential word as one of its parts names a field
# rather than holding one: `customer_password_reset_template`, `payment-auth-token`.
FIELD_IDENTIFIER = re.compile(
    r"^([a-z0-9]+[_\-])*(passwd|password|secret|token|auth|credentials?)([_\-][a-z0-9]+)*$"
)


def _looks_like_secret(value: str) -> bool:
    """Reject values that carry a credential-shaped name but obvious other content."""
    if NOT_SECRET_VALUE.match(value) or FIELD_IDENTIFIER.match(value):
        return False
    # Real keys mix letters and digits, or are long enough that it does not matter.
    has_digit = any(c.isdigit() for c in value)
    has_alpha = any(c.isalpha() for c in value)
    return (has_digit and has_alpha) or len(value) >= LONG_ENOUGH


LONG_ENOUGH = 24
REDACT_KEEP = 4


def _redact(secret: str) -> str:
    """Show enough of a match to find it, never enough to use it."""
    return secret[:REDACT_KEEP] + "…" if len(secret) > REDACT_KEEP else "…"


def scan_text(path: str, text: str) -> list[str]:
    rules = list(ASSIGNED)
    if CONFIG_FILES.search(path):
        rules.append(CONFIG_LINE)
    if YAML_FILES.search(path):
        rules.append(YAML_LINE)
    findings: list[str] = []
    for lineno, line in enumerate(text.splitlines(), start=1):
        if ALLOW_PRAGMA.search(line):
            continue
        # One finding per value: several rules can describe the same assignment.
        seen: set[str] = set()
        for label, pattern in ISSUED:
            match = pattern.search(line)
            found = match.group(0) if match else ""
            if not match or any(found in known or known in found for known in seen):
                continue
            if not PLACEHOLDER.match(match.group(0)):
                seen.add(match.group(0))
                findings.append(f"{path}:{lineno}: {label} ({_redact(match.group(0))})")
        for label, pattern in rules:
            match = pattern.search(line)
            value = match.group(1) if match else ""
            if not match or any(value in known or known in value for known in seen):
                continue
            if not PLACEHOLDER.match(value) and _looks_like_secret(value):
                seen.add(value)
                findings.append(f"{path}:{lineno}: {label} ({_redact(value)})")
    return findings


def _read(path: Path) -> tuple[str | None, list[str]]:
    """Return the file's text, or None plus a finding saying why it was not read."""
    name = path.as_posix()
    try:
        if path.stat().st_size > MAX_BYTES:
            return None, [f"{name}: not scanned, larger than {MAX_BYTES // 1_000_000}MB"]
        with path.open(encoding="utf-8") as handle:
            return handle.read(), []
    except UnicodeDecodeError:
        return None, []  # binary: nothing a text scanner can say
    except OSError as error:
        return None, [f"{name}: not scanned ({error.strerror})"]


@dataclass
class ScanResult:
    """What one file produced, and whether the scanner got to look at it."""

    findings: list[str] = field(default_factory=list)
    problems: list[str] = field(default_factory=list)
    opened: bool = True


def scan_file(path: Path) -> ScanResult:
    """Judge one file. A finding is a suspected credential; a problem is a file
    that could not be read, which is a different thing and is reported as one."""
    if path.name == SELF_NAME:
        return ScanResult()
    name = path.as_posix()
    if FORBIDDEN_NAMES.search(name) and not FORBIDDEN_EXCEPTIONS.search(name):
        return ScanResult(findings=[f"{name}: this file should never be committed"])
    text, problems = _read(path)
    if text is None:
        # A binary file was opened and has nothing a text scanner can say about
        # it. A file that produced a problem was never read at all, and does not
        # count towards the tally deciding whether this run looked at anything.
        return ScanResult(problems=problems, opened=not problems)
    if SELF_MARKER in text:
        return ScanResult()
    return ScanResult(findings=scan_text(name, text))


def _self_test() -> int:
    """Prove the scanner catches what it claims to, and leaves the rest alone."""
    caught = [
        'api_key = "abcdefghijklmnop1234"',
        'WX_API_KEY = os.environ.get("WX_API_KEY", "0123456789abcdef")',
        # The lesson from this project's own history: `\b` does not match beside
        # an underscore, so a `\bsecret\b` scanner let this exact line through.
        'aws_secret_access_key = "wJalrXUtnFEMIK7MDENGbPxRfiCYzKEYQ1W2E3R4"',
        "AWS_KEY_ID=AKIAIOSFODNN7ZQXTPLM",  # matched by the issued-format rule
        '"authorization": "Bearer sk-ant-api03-aaaaaaaaaaaaaaaaaaaaaaaa"',
        "-----BEGIN RSA PRIVATE KEY-----",
        "DATABASE_URL=postgres://user:hunter2hunter2@db.internal/app",
        # PHP array entries, as in app/etc/env.php and module code.
        "'api_key' => '3b9e1f7a0c4d8e2b6a5f9c1d7e3b0a4f8c2d6e1a',",
        '"client_secret" => "9d4a7c2e1b8f3a6d0c5e9b2f7a4d1c8e3b6f0a5d",',
        "'access_key' => 'Qm7vK2xR9pL4tN8wZ3cY6hJ1',",
        "        'password' => 'r8Tq2mVx7LpK4nZw',",
        # A JSON or Python dict key closes its quote before the colon.
        '{"token": "c1e8a5f2b9d6c3a0e7b4f1d8a5c2e9b6f3a0d7c4"}',
        # XML elements, as in a Magento module's etc/config.xml defaults.
        "<api_key>7f2c9a4e1d6b3f8a5c0e7d2b9f4a1c6e3d8b5a0f</api_key>",
        "            <client_secret>e5b2d9f6a3c0e7b4d1a8f5c2e9b6d3a0f7c4e1b8</client_secret>",
        '<password backend_model="Encrypted">h6Wd3pQz9Kx2Lm7v</password>',
        # Near misses of the path and identifier exclusions that are still secrets.
        "'client_secret' => 'tR4nQ8vLm2Kx/Zp7Wc3Yh9Jd/Bf6Gs1Na5Ue0Vq',",
        "'client_secret' => '/Zp7Wc3Yh9Jd/Bf6Gs1Na5Ue0VqtR4nQ8vLm2Kx',",
        "'password' => 'Blue_Heron_Password_2291',",
        "'api_key' => '7:9:Wq3Rt8Yp2Lk6Mn4Bv1Cx5Zs',",
        "'client_secret' => 'k9:3:Zx4Qw7mR2pL8tN3vB6yH1jD',",
        # Provider formats without a credential-shaped name beside them.
        # Split so a host's own secret scanning does not take these specimens for real keys.
        'curl -H "Api-Key: NRAK' + '-UJZDE8GXD6NCF10EPF91DHODZDO" https://api.newrelic.com/graphql',
        "newrelic.license = 149d439536b3216fdaee" + "b975729fae923d5aNRAL",
        "client = OpenAI(api_key=sk-proj-j7FAc9QeWJKY40uvSwMF" + "LZDe1f8rESQedUStPKR0)",
        "https://hooks.slack.com/services/T2SYWB3WK/BH5DNSIPZ/z63FfkCzJr4i" + "0B3JrTAwR4y9",
        "git clone https://oauth2:glpat-ojfljoQoaF" + "1LlqsajAIx@gitlab.com/group/repo.git",
        "GOCSPX-NKu8iS2G8NPRVd" + "D53X83RZJzzzzg",
        "jira login ATATT3xFfGF0EOzdmenCkhvMdgaKjIg8" + "xNbe3nNyjOq9wMxEhh2FDEEtfjgVvVqE",
        "bitbucket ATBB1SkHbn88HxjS" + "I6bWHtP3fS2qHx6k",
        "X-Shopify-Access-Token: shpat_b7a767c76fb008f8" + "6bebb2737f6a6f0f",
        "curl -s --user api:key-b23c6f5da2cec255" + "404e4fb440034d66 https://api.mailgun.net/v3",
        "npm_bqnsGpWLuqIA1id6Vw" + "5DQL05HA064GiIjHGb",
        "//registry.npmjs.org/:_authToken=3CXlMaXZjljENUhJdu" + "RHHJEYXg4JdpmrcXgG",
        "docker login -u me -p dckr_pat_CJbW56eCuNGMG" + "mSrCGIZEG8pSH4",
        "hf_487q7J58m1CiAhzCu" + "eQpBenQtYh5Xj8TPQ",
        "bot 123456789:AAxjq4i9DoV8gz4Fk" + "Q1okTBGzvAmwufUxbv",
        "https://discord.com/api/webhooks/877065894811311440/5XlrWi0B26R08qzjI6GKFSufrdZSlB5er8"
        + "bOfZqfM2oeq3hDavJA76rNicHTp8hkqdlm",
        "DefaultEndpointsProtocol=https;AccountName=store;"
        + "AccountKey=7tOtHWnsCGRlrwZbqcabUGJmGEp7CgQ0PBQFI14zGtS"
        + "novm14TUOizwd1iaeOV4qBkdfQ1y3GQsMpSscDlkrCa==",
        "-----BEGIN PGP PRIVATE KEY BLOCK-----",
        "-----BEGIN OPENSSH PRIVATE KEY-----",
        "PuTTY-User-Key-File-3: ssh-ed25519",
        # Unquoted, inside a command or a note rather than alone on a .env line.
        "sudo NEW_RELIC_API_KEY=Zq8vL3mK7xR2wP5nT4 NEW_RELIC_ACCOUNT_ID=1234 newrelic install",
        "docker run -e DB_PASSWORD=Zq8vL3mK7xR2wP5n app",
        "RUN NR_INSTALL_KEY=Zq8vL3mK7xR2wP5nT4 ./install.sh",
        "mysql --password=Zq8vL3mK7 -e 'select 1'",
        "terraform apply --api-token=Zq8vL3mK7xR2wP5n",
    ]
    caught_yaml = [
        "db_password: Zq8vL3mK7xR2wP5n",
        "  - api_token: Zq8vL3mK7xR2wP5nT4bY",
        "newrelic_license_key: 149d439536b3216fdaeeb975729fae92",
    ]
    ignored_yaml = [
        'db_password: "{{ vault_db_password }}"',
        "db_password: !vault |",
        "token: ${{ secrets.GITHUB_TOKEN }}",
        "password: *db_password_anchor",
        "auth_method: kubernetes_service",
        "token_url: https://auth.internal/oauth/token",
        "password_file: /run/secrets/db_password",
        "db_password:",
    ]
    ignored = [
        'api_key = ""',
        'api_key = "<REDACTED>"',
        'api_key = "your-api-key-here"',
        'MYAPP_ANTHROPIC_API_KEY=""',
        'token = "xxxxxxxxxxxxxxxx"',
        'api_key = os.environ.get("MYAPP_API_KEY")',
        'api_key = "abcdefghijklmnop1234"  # pragma: allowlist secret',
        'twilio_from = "+15550001111"',
        # Credential-shaped names whose values plainly are not secrets.
        "max_tokens=self.settings.agent_max_tokens,",
        "tokenize = 'unicode61 remove_diacritics 2',",
        'TOKEN_FILENAME = "google-token.json"',
        'authorization_prompt_message="Open this URL to authorise the app"',
        "password = passwords.generate_password(12)",
        # AWS publishes these two in its own documentation. Suppressing anything
        # containing "EXAMPLE" is deliberate, and costs nothing: a real key does
        # not carry the word.
        "AWS_KEY_ID=AKIAIOSFODNN7EXAMPLE",
        'aws_secret_access_key = "wJalrXUtnFEMIK7MDENGbPxRfiCYEXAMPLEKEY"',
        # Placeholders in the PHP array and XML forms.
        "'password' => '',",
        "'api_key' => '${MAGENTO_API_KEY}',",
        "'client_secret' => '%env(CLIENT_SECRET)%',",
        "'access_key' => 'changeme-access-key',",
        '"token" => "your-token-goes-here",',
        "<api_key></api_key>",
        "<api_key>${API_KEY}</api_key>",
        "<client_secret>%env(CLIENT_SECRET)%</client_secret>",
        "<password>example-password-1234</password>",
        "<token>xxxxxxxxxxxxxxxxxxxx</token>",
        "'api_key' => '3b9e1f7a0c4d8e2b6a5f9c1d7e3b0a4f8c2d6e1a', // pragma: allowlist secret",
        (
            "<api_key>7f2c9a4e1d6b3f8a5c0e7d2b9f4a1c6e3d8b5a0f</api_key>"
            " <!-- pragma: allowlist secret -->"
        ),
        # Magento values under credential-shaped keys that name something else.
        "<tokenFormat>Vendor\\Payment\\Model\\TokenFormatter</tokenFormat>",
        "public const PATH_ACCESS_KEY = 'remote_storage/access_key';",
        "'Vendor_Customer/change-password': 'Vendor_Customer/js/change-password',",
        '"passwordSelector": "#current-password,#password,#password-confirmation"',
        (
            "<reset_password_template>vendor_customer_reset_password_template"
            "</reset_password_template>"
        ),
        "'password' => 'catalog_search_opensearch_password',",
        '"azure_federated_token_file": "/var/run/secrets/azure/token",',
        '"token_not_after": "20900101010102Z",',
        '"passwordRevisionDate": "2022-07-26T23:03:23.399Z",',
        # Magento ciphertext needs the store's crypt key to read, as stored, in
        # JSON and in a readline history that writes a backslash as \134.
        "'password' => '0:3:Jom7l1J3yXlLdATtMN13wd0cNkFM63/P',",
        '{"token":"0:3:dIRxLh6njRGqCDnWQpKZG96dFaWxS\\/zjScdDlh3iCx8tNeTXpzuqALc32mGJ7hbo"}',
        '"timeout":5,"token":"0:3:2IGKJDBoKc4E2alMrPIz\\134/kxw0lWhgz6f2MwnTApFvOY="}',
        "<api_key>0:2:Tc4DqMowCR3dwUlr:2IGKJDBoKc4E2alMrPIz/kxw0lWhgz6f2MwnTApFvOY=</api_key>",
        # Unquoted names and flags that are not holding a literal secret.
        "GITHUB_TOKEN=${{ secrets.GITHUB_TOKEN }}",
        "export DB_PASSWORD=${DB_PASSWORD:-}",
        "API_KEY=$NEW_RELIC_API_KEY",
        "TOKENIZER=unicode61remove2x",
        # A name that points at a credential rather than holding one.
        "ARG CREDENTIAL_GUARD_REF=915b3c8e0d4f7a2b6c1e9d8f3a5b7c0e2d4f6a8b",
        "AWS_SECRET_ARN=arn1a2b3c4d5e6f7g8h9",
        "SECRET_NAME=database_credentials_prod",
        "ACCESS_KEY_PARAM=/prod/aws/access_key_id",
        "PASSWORD_RESET_URL=https://shop.internal/reset/path",
        "--password-file=/run/secrets/db_password",
        "--token=$GITHUB_TOKEN",
        "--passthrough=enabled_for_all_users",
        'mysql --password="$DB_PASSWORD"',
        "cache-key-5f4dcc3b5aa765d61d8327deb882cf99",
        "//registry.npmjs.org/:_authToken=${NPM_TOKEN}",
        'if [ "$API_TOKEN" == "" ]; then exit 1; fi',
    ]
    cases = [("t", line, True) for line in caught]
    cases += [("t", line, False) for line in ignored]
    cases += [("t.yml", line, True) for line in caught_yaml]
    cases += [("t.yml", line, False) for line in ignored_yaml]
    failures = 0
    for path, line, should_catch in cases:
        hits = scan_text(path, line)
        if should_catch and not hits:
            print(f"  MISS: {line}")
            failures += 1
        elif not should_catch and hits:
            print(f"  FALSE POSITIVE: {line} -> {hits}")
            failures += 1
        elif should_catch and len(hits) > 1:
            print(f"  REPORTED TWICE: {line} -> {hits}")
            failures += 1
    total = len(cases)
    print(f"self-test: {total - failures}/{total} passed")
    return 1 if failures else 0


FILES_FROM = "--files0-from"
FILES_FROM_ARGC = 2  # the option and its LIST


def _names_from(source: str) -> list[str]:
    """Read NUL-separated file names from a file, or from standard input for '-'."""
    data = sys.stdin.buffer.read() if source == "-" else Path(source).read_bytes()
    return [os.fsdecode(name) for name in data.split(b"\0") if name]


def main(argv: list[str]) -> int:
    if "--self-test" in argv:
        return _self_test()
    paths = argv
    if argv[:1] == [FILES_FROM]:
        if len(argv) != FILES_FROM_ARGC:
            print(f"{SELF_NAME}: {FILES_FROM} takes one LIST and no files", file=sys.stderr)
            return 2
        try:
            paths = _names_from(argv[1])
        except OSError as error:
            print(
                f"{SELF_NAME}: cannot read the file list {argv[1]} ({error.strerror});"
                " nothing was scanned",
                file=sys.stderr,
            )
            return 2
    # Exit 0 has to mean "opened every file and found nothing". A run that
    # opened none of them is not a clean result, it is an absent one, and
    # reporting it as clean is how an unscanned tree gets called cleared.
    if not paths:
        print(f"{SELF_NAME}: no files given; nothing was scanned", file=sys.stderr)
        return 2
    findings: list[str] = []
    problems: list[str] = []
    opened = 0
    for name in paths:
        result = scan_file(Path(name))
        findings.extend(result.findings)
        problems.extend(result.problems)
        opened += result.opened

    # A file that could not be read is not a credential and is never reported as
    # one. It is the other half of the same duty: an unreadable file is a file
    # this run cannot clear, so it fails rather than passing quietly.
    if problems:
        print(
            f"{SELF_NAME}: {len(problems)} of {len(paths)} file(s) could not be scanned.",
            file=sys.stderr,
        )
        for problem in problems:
            print(f"  {problem}", file=sys.stderr)
        print(file=sys.stderr)
    if opened == 0:
        print(f"{SELF_NAME}: nothing was scanned, so nothing is cleared.", file=sys.stderr)
        return 2

    if findings:
        print("Refusing to commit: this looks like a credential.\n")
        for finding in findings:
            print(f"  {finding}")
        print(
            "\nIf the key is real: remove it, then rotate it — a commit is not the"
            "\nonly place it has been. If it is a false positive, append"
            "\n`# pragma: allowlist secret` to that line."
        )
    return 1 if findings or problems else 0


def run(argv: list[str]) -> int:
    """Run the scanner, reporting an unexpected error as a failed scan rather than a finding."""
    try:
        return main(argv)
    except Exception:
        logging.getLogger(SELF_NAME).exception(
            "%s: the scanner failed, so nothing is cleared.", SELF_NAME
        )
        return 2


if __name__ == "__main__":
    sys.exit(run(sys.argv[1:]))
