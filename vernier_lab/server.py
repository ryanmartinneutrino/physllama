from contextlib import asynccontextmanager
from pathlib import Path
from urllib.parse import urlparse

from fastapi import FastAPI, HTTPException, Query, Request
from fastapi.responses import FileResponse, JSONResponse, Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field
from starlette.middleware.trustedhost import TrustedHostMiddleware

from .acquisition import Lab

STATIC = Path(__file__).parent / 'static'


class DeviceRequest(BaseModel):
    device_id: str


class Configuration(BaseModel):
    selections: dict[str, list[int]]
    period_ms: float = Field(ge=10, le=10000, allow_inf_nan=False)


def create_app(lab=None, on_shutdown=None):
    lab = lab or Lab()

    @asynccontextmanager
    async def lifespan(app):
        lab.launch()
        yield
        await lab.call('shutdown')
        lab.thread.join(timeout=5)

    app = FastAPI(title='Vernier Lab', lifespan=lifespan)
    app.state.lab = lab
    app.add_middleware(TrustedHostMiddleware, allowed_hosts=['127.0.0.1', 'localhost', '[::1]', 'testserver'])

    @app.middleware('http')
    async def local_requests(request: Request, call_next):
        origin = request.headers.get('origin')
        if origin and urlparse(origin).netloc != request.headers.get('host'):
            return JSONResponse({'detail': 'Open the app from its localhost address.'}, status_code=403)
        response = await call_next(request)
        response.headers['X-Content-Type-Options'] = 'nosniff'
        if request.url.path.startswith('/api/'):
            response.headers['Cache-Control'] = 'no-store'
        return response

    async def execute(action, **kwargs):
        try:
            return await lab.call(action, **kwargs)
        except ValueError as exc:
            raise HTTPException(400, str(exc)) from exc
        except Exception as exc:
            raise HTTPException(503, f'Device operation failed: {exc}') from exc

    @app.get('/api/state')
    async def state(after: int = Query(default=0, ge=0), generation: str = ''):
        return await execute('snapshot', after=after, generation=generation)

    @app.get('/api/app')
    async def app_info():
        return {'name': 'Vernier Lab', 'desktop': on_shutdown is not None}

    @app.post('/api/quit')
    async def quit_app():
        if on_shutdown is None:
            raise HTTPException(400, 'Stop the app from its terminal.')
        await execute('stop')
        on_shutdown()
        return {'quitting': True}

    @app.post('/api/scan')
    async def scan():
        return await execute('scan')

    @app.post('/api/demo')
    async def demo():
        return await execute('add_demo')

    @app.post('/api/connect')
    async def connect(body: DeviceRequest):
        return await execute('connect', **body.model_dump())

    @app.post('/api/disconnect')
    async def disconnect(body: DeviceRequest):
        return await execute('disconnect', **body.model_dump())

    @app.post('/api/battery')
    async def battery(body: DeviceRequest):
        return await execute('battery', **body.model_dump())

    @app.post('/api/configure')
    async def configure(body: Configuration):
        return await execute('configure', **body.model_dump())

    @app.post('/api/start')
    async def start(body: Configuration | None = None):
        return await execute('start', **(body.model_dump() if body else {}))

    @app.post('/api/stop')
    async def stop():
        return await execute('stop')

    @app.post('/api/reset')
    async def reset():
        return await execute('reset')

    @app.get('/api/export')
    async def export(series: list[str] | None = Query(default=None)):
        content = await execute('export_csv', series_ids=series)
        return Response(content, media_type='text/csv; charset=utf-8', headers={
            'Content-Disposition': 'attachment; filename="vernier-experiment.csv"'})

    @app.get('/')
    async def index():
        return FileResponse(STATIC / 'index.html')

    app.mount('/static', StaticFiles(directory=STATIC), name='static')
    return app


app = create_app()
