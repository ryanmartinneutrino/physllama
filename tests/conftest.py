import pytest


@pytest.fixture(autouse=True)
def isolated_settings(monkeypatch, tmp_path):
    monkeypatch.setenv('PHYSLLAMA_DATA_DIR', str(tmp_path / 'settings'))
