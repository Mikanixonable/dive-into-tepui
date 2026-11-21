# git filter-repo --commit-callback で読むコールバック。
# commit.original_id(fast-export の original-oid、元の SHA)を msgmap.json へ引き、
# メッセージだけを差し替える。テーブルは最初の呼び出しで一度だけ読む
# (globals は同一コールバック内で共有される)。
import json
import os

_map = globals().get('_ja_msgmap')
if _map is None:
    _path = os.path.join(os.getcwd(), 'tools', 'commit-message-ja', 'msgmap.json')
    with open(_path, 'r', encoding='utf-8') as _f:
        _map = json.load(_f)
    globals()['_ja_msgmap'] = _map

_key = commit.original_id
if isinstance(_key, (bytes, bytearray)):
    _key = _key.decode('ascii')
_new = _map.get(_key)
if _new is not None:
    commit.message = _new.encode('utf-8')
