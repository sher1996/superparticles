"""Start the dashboard (and the daily scheduler): python run.py
Then open http://127.0.0.1:8000 in your browser."""
import uvicorn

from app.config import get_env

if __name__ == "__main__":
    env = get_env()
    print(f"bol Opportunity Engine - {env.mode.upper()} mode - http://{env.host}:{env.port}")
    uvicorn.run("app.web.main:app", host=env.host, port=env.port, log_level="warning")
