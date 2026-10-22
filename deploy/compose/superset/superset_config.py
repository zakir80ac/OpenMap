# REQ-UI-017 — Superset configuration for embedded analytics. Values come from the compose environment.
import os

SECRET_KEY = os.environ["SUPERSET_SECRET_KEY"]
SQLALCHEMY_DATABASE_URI = (
    f"postgresql+psycopg2://{os.environ['DATABASE_USER']}:{os.environ['DATABASE_PASSWORD']}"
    f"@{os.environ['DATABASE_HOST']}:{os.environ['DATABASE_PORT']}/{os.environ['DATABASE_DB']}"
    "?options=-csearch_path%3Dsuperset"
)

# The API grants the embedded guest role its permissions through the security API at provisioning time.
FAB_ADD_SECURITY_API = True

FEATURE_FLAGS = {
    "EMBEDDED_SUPERSET": True,
    "DASHBOARD_RBAC": True,
    "ROW_LEVEL_SECURITY": True,
    "ALERT_REPORTS": True,
}

# Embedding into the OpenMap console: the console origin is injected by the API at runtime via guest tokens.
GUEST_ROLE_NAME = "OpenMapEmbedded"
GUEST_TOKEN_JWT_SECRET = SECRET_KEY
GUEST_TOKEN_JWT_EXP_SECONDS = 300
TALISMAN_ENABLED = False
WTF_CSRF_ENABLED = True
WTF_CSRF_EXEMPT_LIST = ["superset.views.core.log", "superset.security.api.guest_token"]
ENABLE_PROXY_FIX = True
LANGUAGES = {"en": {"flag": "us", "name": "English"}, "ar": {"flag": "sa", "name": "Arabic"}}
BABEL_DEFAULT_LOCALE = "en"
