import pytest
from fastapi.testclient import TestClient

import run


@pytest.mark.parametrize('arguments,host,port,network_allowed', [
    (['--no-browser'], '127.0.0.1', 8765, False),
    (['--no-browser', '--port', '8081'], '127.0.0.1', 8081, False),
    (['--server'], '0.0.0.0', 8765, True),
    (['--server', '--port', '8081'], '0.0.0.0', 8081, True),
    (['--multi'], '0.0.0.0', 8765, True),
    (['--multi', '--port', '8081'], '0.0.0.0', 8081, True),
    (['--multi', '--server', '--no-browser'], '0.0.0.0', 8765, True),
])
def test_launcher_network_access_and_browser_behavior(monkeypatch, arguments, host, port, network_allowed):
    def unexpected_browser(*args, **kwargs):
        pytest.fail('A browser should not open in server or no-browser mode')

    def serve(app, **config):
        assert config['host'] == host
        assert config['port'] == port
        with TestClient(app, base_url=f'http://lab-computer:{port}') as client:
            response = client.get('/')
            assert response.status_code == (200 if network_allowed else 400)
            if network_allowed:
                assert 'PhysLlama' in response.text
                assert client.get('/static/app.js').status_code == 200
                assert client.get('/api/session').json()['multi'] is ('--multi' in arguments)
                if '--multi' in arguments:
                    assert client.get('/api/state').status_code == 401
                    assert client.post('/api/groups', json={'name': 'Launch test group'}).status_code == 200
                assert client.post('/api/demo', headers={'Origin': f'http://lab-computer:{port}'}).status_code == 200
                assert client.get('/api/state').json()['devices'][0]['connected']
                for origin in ('http://other-computer:8081', 'http://lab-computer:9999'):
                    assert client.post('/api/demo', headers={'Origin': origin}).status_code == 403
                assert len(client.get('/api/state').json()['devices']) == 1

    monkeypatch.setattr(run.threading, 'Timer', unexpected_browser)
    monkeypatch.setattr(run.uvicorn, 'run', serve)
    run.main(arguments)


@pytest.mark.parametrize('port', ['0', '-1', '65536', 'hello'])
def test_invalid_port_rejected_before_launch(monkeypatch, port):
    monkeypatch.setattr(run.uvicorn, 'run', lambda *args, **kwargs: pytest.fail('Invalid port launched server'))
    with pytest.raises(SystemExit) as error:
        run.main(['--server', '--port', port])
    assert error.value.code == 2


def test_desktop_bundle_forwards_explicit_classroom_arguments(monkeypatch):
    import desktop
    invoked = []
    monkeypatch.setattr(run, 'main', lambda argv: invoked.append(argv))
    desktop.main(['--multi', '--port', '8081'])
    assert invoked == [['--multi', '--port', '8081']]
