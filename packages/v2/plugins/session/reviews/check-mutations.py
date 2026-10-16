from pathlib import Path
import hashlib,json,os,shutil,subprocess,sys,tempfile
source=Path(sys.argv[1]).resolve();workspace=source/'packages/v2' if (source/'packages/v2').is_dir() else source
bun=shutil.which('bun');node_modules=workspace.parent.parent/'node_modules'
files=['plugins/session/src/__test__/contract.test.ts','plugins/session/src/__test__/transaction-boundaries.test.ts','plugins/session/src/contracts/__test__/snapshot-json.test.ts','plugins/session-storage-sql/src/__test__/public-contract.test.ts','plugins/session-storage-sql/src/__test__/transaction-boundaries.test.ts']
mutations=[
 ('revision-check','plugins/session-storage-sql/src/commit-session.ts','if (head.value.revision !== expectedRevision) return fail("revision-conflict");','', 'stale storage commits'),
 ('commit-identity','plugins/session-storage-sql/src/commit-session.ts','previous.value.fingerprint === input.fingerprint','true','storage commit identity'),
 ('position-order','plugins/session/src/domain/project-entries.ts','if (entry.replace) {','if (entry.replace) { if (entry.replace.startSeq > entry.replace.endSeq) return fail("invalid-replacement");','numerically reversed'),
 ('business-rollback','plugins/session-storage-sql/src/open-store.ts','if (!result.ok) { rejected = result; throw rollback; }','if (!result.ok) return result;','business failure after mutations'),
 ('incremental-budget','plugins/session/src/contracts/snapshot-json.ts','if (bytes > budget) throw capacity;','','repeated large references'),
 ('utf8-boundary','plugins/session/src/domain/read-entry.ts','new TextEncoder().encode(value).length <= 128','true','UTF-8 bytes'),
]
result={'baselinePassed':False,'controls':[]}
with tempfile.TemporaryDirectory(prefix='session-mutations-') as directory:
 root=Path(directory);target=root/'packages/v2';shutil.copytree(workspace,target,ignore=shutil.ignore_patterns('node_modules','coverage','dist','.vite','.DS_Store'))
 (root/'node_modules').symlink_to(node_modules,target_is_directory=True)
 if (workspace/'node_modules').exists():(target/'node_modules').symlink_to((workspace/'node_modules').resolve(),target_is_directory=True)
 command=[bun,str(node_modules/'vitest/vitest.mjs'),'run',*files,'--config','vitest.config.ts']
 def run():return subprocess.run(command,cwd=target,text=True,stdout=subprocess.PIPE,stderr=subprocess.STDOUT,timeout=60)
 baseline=run();assert baseline.returncode==0,baseline.stdout;result['baselinePassed']=True
 for name,path,before,after,symptom in mutations:
  file=target/path;original=file.read_text();assert original.count(before)==1,(name,original.count(before));mutant=original.replace(before,after)
  try:
   file.write_text(mutant);tested=run();detected=tested.returncode!=0 and 'AssertionError' in tested.stdout and symptom in tested.stdout and 'Failed Suites' not in tested.stdout and 'Transform failed' not in tested.stdout
   result['controls'].append({'name':name,'detected':detected,'sourceSha256':hashlib.sha256(original.encode()).hexdigest(),'mutantSha256':hashlib.sha256(mutant.encode()).hexdigest(),'evidence':tested.stdout})
   assert detected,(name,tested.stdout)
  finally:file.write_text(original)
print(json.dumps(result,indent=2))
