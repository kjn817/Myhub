#!/usr/bin/env python3
"""
deploy_full.py 단일 실행 잠금 테스트 (재구축, 2026-11-07)

소실된 원본: tests/test_deploy_full_flow.py의 잠금 케이스
(커밋 b1fcf5cc, 2026-11-06 — "동시 실행 시뮬레이션 테스트 PASS" 기록).

계약 (복원된 deploy_full.py 실물로 확정):
- `.deploy_full.lock`을 O_EXCL로 원자적 획득, 성공 시 경로를 반환한다.
- 잠금 파일은 JSON {pid, cmdline, started_at} — 보유자 정보다.
- 경합 시 보유자 정보를 stderr에 출력하고 exit 3으로 거부한다.
- 보유자 판정은 기록이 아니라 실프로세스 기준: pid가 살아 있고 그 프로세스의
  /proc cmdline에 deploy_full이 있을 때만 보유자로 인정한다 (pid 재사용 가드).
  죽은 pid·비배포 프로세스·깨진 파일은 stale로 회수하고 재획득한다.
- 해제는 자기 pid가 기록된 잠금만 지운다.

주의: 경합 테스트는 같은 프로세스의 재획득이 아니라, cmdline에 deploy_full을
가진 별도 프로세스를 보유자로 세워 검증한다 (구현이 보유자를 실프로세스로
판정하므로 그래야 의미가 있다 — 동시 실행 시뮬레이션의 원본 형태).

네트워크는 사용하지 않는다.
"""

import contextlib
import importlib.util
import io
import json
import os
import subprocess
import sys
import time

sys.argv = ['deploy_full.py', 'production']
sys.path.insert(0, '.')
_spec = importlib.util.spec_from_file_location('deploy_full', 'deploy_full.py')
df = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(df)

LOCK_PATH = os.path.join(os.path.dirname(os.path.abspath('deploy_full.py')), '.deploy_full.lock')


def _write_lock(pid, cmdline='python3 deploy_full.py production'):
    with open(LOCK_PATH, 'w', encoding='utf-8') as f:
        json.dump({'pid': pid, 'cmdline': cmdline,
                   'started_at': '2026-11-07T00:00:00+00:00'}, f)


def _read_lock():
    with open(LOCK_PATH, encoding='utf-8') as f:
        return json.load(f)


def _cleanup():
    try:
        os.unlink(LOCK_PATH)
    except FileNotFoundError:
        pass


def _dead_pid():
    p = subprocess.Popen([sys.executable, '-c', 'pass'])
    p.wait()
    return p.pid


def _deploy_like_holder():
    """cmdline에 deploy_full을 가진 살아 있는 프로세스 (보유자 대역).

    fork 직후 exec 전에는 /proc cmdline이 부모의 것이라 보유자 판정이 흔들리므로,
    cmdline에 deploy_full이 실제로 보일 때까지 기다린 뒤 반환한다.
    """
    p = subprocess.Popen(
        [sys.executable, '-c', 'import time; time.sleep(30)', 'deploy_full.py', 'production'])
    for _ in range(100):
        try:
            with open(f'/proc/{p.pid}/cmdline', 'rb') as f:
                if b'deploy_full' in f.read():
                    return p
        except OSError:
            pass
        time.sleep(0.02)
    return p


def test_acquire_creates_lock_with_holder_info():
    _cleanup()
    try:
        result = df.acquire_deploy_lock(LOCK_PATH)
        assert result is not None, '획득 성공 시 잠금 경로를 반환해야 한다'
        assert os.path.exists(LOCK_PATH), '잠금 파일이 생성돼야 한다'
        info = _read_lock()
        assert info['pid'] == os.getpid(), f"보유자 pid 기록이 잘못됨: {info}"
        assert 'deploy_full' in info['cmdline']
        assert info.get('started_at'), '시작 시각이 기록돼야 한다'
    finally:
        df.release_deploy_lock(LOCK_PATH)
        _cleanup()
    print('lock: 획득 + 보유자(JSON: pid·cmdline·started_at) 기록 PASS')


def test_contention_with_live_deploy_process_exit3():
    _cleanup()
    holder = _deploy_like_holder()
    try:
        _write_lock(holder.pid)
        stderr = io.StringIO()
        code = None
        with contextlib.redirect_stderr(stderr):
            try:
                df.acquire_deploy_lock(LOCK_PATH)
            except SystemExit as e:
                code = e.code
        assert code == 3, f'살아 있는 배포 프로세스와 경합하면 exit 3이어야 한다 (실제 {code})'
        assert str(holder.pid) in stderr.getvalue(), '거부 메시지에 보유자 정보가 있어야 한다'
        # 남의 잠금을 지우지 않는다
        assert _read_lock()['pid'] == holder.pid
    finally:
        holder.terminate()
        holder.wait()
        _cleanup()
    print('lock: 경합 거부(exit 3 + 보유자 정보) PASS')


def test_stale_lock_from_dead_pid_is_reclaimed():
    _cleanup()
    try:
        _write_lock(_dead_pid())
        df.acquire_deploy_lock(LOCK_PATH)
        assert _read_lock()['pid'] == os.getpid(), '회수 후에는 새 보유자로 교체돼야 한다'
    finally:
        df.release_deploy_lock(LOCK_PATH)
        _cleanup()
    print('lock: stale(죽은 PID) 회수 PASS')


def test_stale_lock_with_non_deploy_cmdline_is_reclaimed():
    """pid가 살아 있어도 그 프로세스가 배포가 아니면(pid 재사용) stale로 회수한다."""
    _cleanup()
    sleeper = subprocess.Popen(['sleep', '30'])
    try:
        _write_lock(sleeper.pid)
        df.acquire_deploy_lock(LOCK_PATH)
        assert _read_lock()['pid'] == os.getpid()
    finally:
        sleeper.terminate()
        sleeper.wait()
        df.release_deploy_lock(LOCK_PATH)
        _cleanup()
    print('lock: stale(pid 재사용·비배포 프로세스) 회수 PASS')


def test_broken_lock_file_is_reclaimed():
    _cleanup()
    try:
        with open(LOCK_PATH, 'w', encoding='utf-8') as f:
            f.write('이것은 JSON이 아니다')
        df.acquire_deploy_lock(LOCK_PATH)
        assert _read_lock()['pid'] == os.getpid(), '깨진 잠금 파일은 stale로 보고 회수해야 한다'
    finally:
        df.release_deploy_lock(LOCK_PATH)
        _cleanup()
    print('lock: 깨진 잠금 파일 회수 PASS')


def test_release_allows_reacquire():
    _cleanup()
    try:
        df.acquire_deploy_lock(LOCK_PATH)
        df.release_deploy_lock(LOCK_PATH)
        assert not os.path.exists(LOCK_PATH), '해제 후 잠금 파일이 제거돼야 한다'
        df.acquire_deploy_lock(LOCK_PATH)
        assert _read_lock()['pid'] == os.getpid()
    finally:
        df.release_deploy_lock(LOCK_PATH)
        _cleanup()
    print('lock: 해제 후 재획득 PASS')


if __name__ == '__main__':
    tests = [v for k, v in sorted(globals().items()) if k.startswith('test_')]
    failed = 0
    for t in tests:
        try:
            t()
        except Exception as e:  # noqa: BLE001 — 단독 실행 시 전 테스트 결과 수집용
            failed += 1
            print(f'FAIL {t.__name__}: {e}')
        time.sleep(0.05)
    print(f'\n{len(tests) - failed}/{len(tests)} PASS')
    sys.exit(1 if failed else 0)
