import os

_drop = set()
_dpath = '/tmp/drop-shas.txt'
if os.path.exists(_dpath):
    with open(_dpath) as _f:
        _drop = {l.strip() for l in _f if l.strip()}

_oid = getattr(commit, 'original_id', None)
_sha = _oid.decode() if isinstance(_oid, bytes) else str(_oid) if _oid else ''
if _sha in _drop and len(getattr(commit, 'parents', [])) <= 1:
    commit.skip()
