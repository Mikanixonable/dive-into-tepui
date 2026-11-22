#!/usr/bin/env python3
"""重複コミットを収縮除去した新 DAG を commit-tree で再構築する。
保持コミットは元の tree・author・committer・message をそのまま使い、
drop コミットは子の親を最近の保持祖先へ張り替える(tree 完全保存)。
"""
import subprocess, sys, os, json

REPO = '/Users/pandeaconica/lab/dive-into-tepui'
DROP = set(l.strip() for l in open('/tmp/drop-shas.txt') if l.strip())

def git(*args, input=None, env=None, cwd=REPO):
    return subprocess.run(['git', *args], capture_output=True,
                          input=input, env=env, cwd=cwd)

# 1) 全コミットの取得(topo順: 親→子)
out = git('rev-list', '--topo-order', '--all')
order = out.stdout.decode().split()[::-1]
print(f'commits: {len(order)}')

# 2) 各コミットの中身を cat-file --batch で一括読み出し
proc = subprocess.Popen(['git', 'cat-file', '--batch'], cwd=REPO,
                        stdin=subprocess.PIPE, stdout=subprocess.PIPE)
commits = {}
for sha in order:
    proc.stdin.write((sha + '\n').encode())
    proc.stdin.flush()
    header = proc.stdout.readline().decode().split()
    if len(header) < 3 or header[1] != 'commit':
        print('unexpected object:', header); sys.exit(1)
    size = int(header[2]); body = proc.stdout.read(size); proc.stdout.read(1)
    lines = body.split(b'\n\n', 1)
    hdr, msg = lines[0].decode(errors='replace').split('\n'), lines[1]
    c = {'parents': [], 'tree': None, 'author': None, 'committer': None, 'msg': msg}
    for l in hdr:
        if l.startswith('tree '): c['tree'] = l[5:]
        elif l.startswith('parent '): c['parents'].append(l[7:])
        elif l.startswith('author '): c['author'] = l[7:]
        elif l.startswith('committer '): c['committer'] = l[10:]
    commits[sha] = c
proc.stdin.close(); proc.wait()
print('loaded')

def ident_env(prefix, line):
    # "Name <mail> ts tz"
    name = line.split(' <')[0]
    mail = line.split('<')[1].split('>')[0]
    ts, tz = line.rsplit(' ', 2)[1:]
    return {f'GIT_{prefix}_NAME': name, f'GIT_{prefix}_EMAIL': mail,
            f'GIT_{prefix}_DATE': f'{ts} {tz}'}

# 3) 再構築
image = {}       # old sha -> new sha (保持コミット)
resolved = {}    # dropped sha -> 継ぎ先 new-sha リスト
anc = {}         # new sha -> 祖先 bitset (new index 割当)
idx_of = {}
nidx = [0]

for sha in order:
    c = commits[sha]
    # 親の写像を解決: kept→image、 dropped→resolved を展開
    par = []
    for p in c['parents']:
        par.extend([image[p]] if p in image else resolved[p])
    if sha in DROP:
        resolved[sha] = par
        continue
    # 重複除去 + 「一方が他方の祖先」なら祖先側を落とす
    par = list(dict.fromkeys(par))
    if len(par) > 1:
        par = [p for p in par
               if not any(p != q and (anc.get(q, 0) >> idx_of[p]) & 1
                          for q in par)]
    env = dict(os.environ)
    env.update(ident_env('AUTHOR', c['author']))
    env.update(ident_env('COMMITTER', c['committer']))
    args = ['commit-tree', c['tree']]
    for p in par: args += ['-p', p]
    r = git(*args, input=c['msg'], env=env)
    new = r.stdout.decode().strip()
    if r.returncode != 0:
        print('FAIL', sha, r.stderr.decode()); sys.exit(1)
    image[sha] = new
    idx_of[new] = nidx[0]; nidx[0] += 1
    b = 1 << idx_of[new]
    for p in par: b |= anc.get(p, 0)
    anc[new] = b

print(f'rebuilt: kept={len(image)} dropped={len(resolved)}')

# 4) ref を新先端へ
out = git('for-each-ref', '--format=%(refname) %(objectname)',
          'refs/heads', 'refs/tags', 'refs/backup', 'refs/stash')
moved, failed = [], []
for l in out.stdout.decode().strip().split('\n'):
    ref, old = l.split(' ')
    if old in image:
        git('update-ref', ref, image[old])
        moved.append(ref)
    else:
        failed.append(ref)
print(f'refs moved: {len(moved)} failed: {len(failed)}')
for f in failed: print('  FAILED:', f)
json.dump(image, open('/tmp/dedup-image-map.json', 'w'))
