import os
from pathlib import Path
from dotenv import load_dotenv

# Base directory of the project
BASE_DIR = Path(__file__).resolve().parent.parent

# Load environment variables from .env if present
load_dotenv(BASE_DIR / '.env')


class Config:
    """Base application configuration."""
    SECRET_KEY = os.getenv('SECRET_KEY', 'dev-insecure-secret-key-disruptioniq-2026')
    
    # Instance folder path for local SQLite database
    INSTANCE_DIR = BASE_DIR / 'instance'
    INSTANCE_DIR.mkdir(parents=True, exist_ok=True)
    
    # Uploads folder
    UPLOAD_DIR = BASE_DIR / 'uploads'
    UPLOAD_DIR.mkdir(parents=True, exist_ok=True)
    
    # Database URL configuration with safe Windows/Unix path normalization
    raw_db_url = os.getenv('DATABASE_URL')
    if raw_db_url and raw_db_url.startswith('sqlite:///') and not raw_db_url.startswith('sqlite:///:memory:'):
        rel_path = raw_db_url[len('sqlite:///'):]
        p = Path(rel_path)
        if not p.is_absolute():
            abs_path = (BASE_DIR / p).resolve()
        else:
            abs_path = p.resolve()
        abs_path.parent.mkdir(parents=True, exist_ok=True)
        SQLALCHEMY_DATABASE_URI = f"sqlite:///{abs_path.as_posix()}"
    else:
        abs_path = (INSTANCE_DIR / 'disruptioniq.db').resolve()
        SQLALCHEMY_DATABASE_URI = f"sqlite:///{abs_path.as_posix()}"

    SQLALCHEMY_TRACK_MODIFICATIONS = False
    
    # Session & Security Settings
    SESSION_COOKIE_HTTPONLY = True
    SESSION_COOKIE_SAMESITE = 'Lax'
    
    # AI / LLM Configuration (Deterministic Fallback by Default)
    LLM_PROVIDER = os.getenv('LLM_PROVIDER', 'none')
    LLM_API_KEY = os.getenv('LLM_API_KEY', '')
    LLM_MODEL = os.getenv('LLM_MODEL', '')


class DevelopmentConfig(Config):
    """Development configuration."""
    DEBUG = True
    TESTING = False


class TestingConfig(Config):
    """Testing configuration with in-memory SQLite database."""
    TESTING = True
    DEBUG = False
    SQLALCHEMY_DATABASE_URI = 'sqlite:///:memory:'
    WTF_CSRF_ENABLED = False
    SECRET_KEY = 'test-secret-key'


class ProductionConfig(Config):
    """Production configuration."""
    DEBUG = False
    TESTING = False
    SESSION_COOKIE_SECURE = True


config_by_name = {
    'development': DevelopmentConfig,
    'testing': TestingConfig,
    'production': ProductionConfig,
    'default': DevelopmentConfig,
}
