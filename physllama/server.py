from contextlib import asynccontextmanager
from pathlib import Path
from typing import Annotated
from urllib.parse import urlparse

from fastapi import Body, FastAPI, HTTPException, Query, Request, Response as HTTPResponse
from fastapi.responses import FileResponse, JSONResponse, Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field
from starlette.middleware.trustedhost import TrustedHostMiddleware

from .acquisition import Lab
from .names import DeviceNames
from .classroom import Classroom, DeviceBusy

STATIC = Path(__file__).parent / 'static'


class DeviceRequest(BaseModel):
    device_id: str


class RenameRequest(DeviceRequest):
    name: str = Field(max_length=60)


Interval = Annotated[float, Field(ge=10, le=10000, allow_inf_nan=False)]


class Configuration(BaseModel):
    selections: dict[str, list[int]]
    # Sampling interval per device ID. period_ms applies to selected devices without an entry.
    periods: dict[str, Interval] = {}
    period_ms: Interval | None = None


class GroupRequest(BaseModel):
    name: str = Field(min_length=1, max_length=60)


class JoinRequest(BaseModel):
    code: str = Field(min_length=1, max_length=32)


class ExperimentRequest(BaseModel):
    name: str = Field(max_length=80)


def create_app(lab=None, on_shutdown=None, server_mode=False, multi_mode=False, classroom=None):
    classroom = (classroom or Classroom()) if multi_mode else None
    lab = None if multi_mode else (lab or Lab(name_store=DeviceNames()))

    @asynccontextmanager
    async def lifespan(app):
        if multi_mode:
            await classroom.launch()
        else:
            lab.launch()
        try:
            yield
        finally:
            if multi_mode:
                await classroom.shutdown()
            else:
                await lab.call('shutdown')
                lab.thread.join(timeout=5)

    app = FastAPI(title='PhysLlama', lifespan=lifespan)
    app.state.lab = lab
    app.state.classroom = classroom
    app.add_middleware(TrustedHostMiddleware, allowed_hosts=(['*'] if server_mode or multi_mode else
                       ['127.0.0.1', 'localhost', '[::1]', 'testserver']))

    @app.middleware('http')
    async def same_origin_requests(request: Request, call_next):
        origin = request.headers.get('origin')
        if origin and urlparse(origin).netloc != request.headers.get('host'):
            return JSONResponse({'detail': 'Open the app from the same server address as this request.'}, status_code=403)
        response = await call_next(request)
        response.headers['X-Content-Type-Options'] = 'nosniff'
        if request.url.path.startswith('/api/'):
            response.headers['Cache-Control'] = 'no-store'
        return response

    def cookie_name(request):
        port = request.url.port or (443 if request.url.scheme == 'https' else 80)
        return f'physllama_group_{port}'

    def current_group(request, required=True):
        group = classroom.authenticate(request.cookies.get(cookie_name(request)))
        if group is None and required:
            raise HTTPException(401, 'Create or join a group to open an experiment.')
        return group

    def set_group_cookie(request, response, group):
        response.set_cookie(cookie_name(request), group.token, httponly=True,
                            samesite='strict', secure=request.url.scheme == 'https', max_age=12 * 60 * 60)

    async def execute(action, request, **kwargs):
        try:
            if multi_mode:
                return await classroom.call(current_group(request), action, **kwargs)
            return await lab.call(action, **kwargs)
        except HTTPException:
            raise
        except DeviceBusy as exc:
            raise HTTPException(409, str(exc)) from exc
        except PermissionError as exc:
            raise HTTPException(403, str(exc)) from exc
        except ValueError as exc:
            raise HTTPException(400, str(exc)) from exc
        except Exception as exc:
            raise HTTPException(503, f'Device operation failed: {exc}') from exc

    @app.get('/api/state')
    async def state(request: Request, after: int = Query(default=0, ge=0), generation: str = ''):
        return await execute('snapshot', request, after=after, generation=generation)

    @app.get('/api/app')
    async def app_info():
        if multi_mode:
            return {'name': 'PhysLlama', 'desktop': False, 'multi': True}
        return {'name': 'PhysLlama', 'desktop': on_shutdown is not None}

    @app.get('/api/session')
    async def session(request: Request):
        group = current_group(request, required=False) if multi_mode else None
        return {'multi': multi_mode, 'group': group.info() if group else None}

    @app.post('/api/groups')
    async def create_group(body: GroupRequest, request: Request, response: HTTPResponse):
        if not multi_mode:
            raise HTTPException(400, 'Start PhysLlama with --multi to create student groups.')
        if current_group(request, required=False):
            raise HTTPException(400, 'End your current group session before creating another.')
        try:
            group = classroom.create(body.name)
        except ValueError as exc:
            raise HTTPException(400, str(exc)) from exc
        set_group_cookie(request, response, group)
        return group.info()

    @app.post('/api/groups/join')
    async def join_group(body: JoinRequest, request: Request, response: HTTPResponse):
        if not multi_mode:
            raise HTTPException(400, 'Start PhysLlama with --multi to join student groups.')
        try:
            group = classroom.join(body.code)
        except ValueError as exc:
            raise HTTPException(400, str(exc)) from exc
        current = current_group(request, required=False)
        if current is not None and current is not group:
            raise HTTPException(400, 'End your current group session before joining another.')
        set_group_cookie(request, response, group)
        return group.info()

    @app.post('/api/groups/end')
    async def end_group(request: Request, response: HTTPResponse):
        if not multi_mode:
            raise HTTPException(400, 'This is an individual instance.')
        try:
            await classroom.end(current_group(request))
        except HTTPException:
            raise
        except Exception as exc:
            raise HTTPException(503, f'Could not release all group devices: {exc}. Try again.') from exc
        response.delete_cookie(cookie_name(request))
        return {'ended': True}

    @app.get('/api/connection-status')
    async def connection_status(request: Request):
        if multi_mode:
            return current_group(request).lab.connection_status()
        return lab.connection_status()

    @app.post('/api/quit')
    async def quit_app(request: Request):
        if on_shutdown is None or multi_mode:
            raise HTTPException(400, 'Stop the app from its terminal.')
        await execute('stop', request)
        on_shutdown()
        return {'quitting': True}

    @app.post('/api/scan')
    async def scan(request: Request):
        return await execute('scan', request)

    @app.post('/api/demo')
    async def demo(request: Request):
        return await execute('add_demo', request)

    @app.post('/api/connect')
    async def connect(body: DeviceRequest, request: Request):
        return await execute('connect', request, **body.model_dump())

    @app.post('/api/disconnect')
    async def disconnect(body: DeviceRequest, request: Request):
        return await execute('disconnect', request, **body.model_dump())

    @app.post('/api/rename')
    async def rename(body: RenameRequest, request: Request):
        return await execute('rename', request, **body.model_dump())

    @app.post('/api/battery')
    async def battery(body: DeviceRequest, request: Request):
        return await execute('battery', request, **body.model_dump())

    @app.post('/api/configure')
    async def configure(body: Configuration, request: Request):
        return await execute('configure', request, **body.model_dump())

    @app.post('/api/experiment')
    async def name_experiment(body: ExperimentRequest, request: Request):
        return await execute('name_experiment', request, **body.model_dump())

    @app.get('/api/experiment/file')
    async def save_experiment(request: Request):
        return await execute('save_experiment', request)

    @app.post('/api/experiment/file')
    async def load_experiment(request: Request, data: dict = Body(...)):
        return await execute('load_experiment', request, data=data)

    @app.post('/api/start')
    async def start(request: Request, body: Configuration | None = None):
        return await execute('start', request, **(body.model_dump() if body else {}))

    @app.post('/api/stop')
    async def stop(request: Request):
        return await execute('stop', request)

    @app.post('/api/reset')
    async def reset(request: Request):
        return await execute('reset', request)

    @app.get('/api/export')
    async def export(request: Request, series: list[str] | None = Query(default=None)):
        content = await execute('export_csv', request, series_ids=series)
        return Response(content, media_type='text/csv; charset=utf-8', headers={
            'Content-Disposition': 'attachment; filename="physllama-experiment.csv"'})

    @app.get('/')
    async def index():
        return FileResponse(STATIC / 'index.html')

    app.mount('/static', StaticFiles(directory=STATIC), name='static')
    return app


app = create_app()
