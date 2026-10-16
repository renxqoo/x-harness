from pathlib import Path
import tempfile,shutil,subprocess,json,re,argparse
parser=argparse.ArgumentParser();parser.add_argument("workspace",type=Path);root=parser.parse_args().workspace.resolve();temp=Path(tempfile.mkdtemp(prefix='kernel-author-manifest-mutation-'));target=temp/'packages/v2'
shutil.copytree(root/'packages/v2',target,ignore=shutil.ignore_patterns('node_modules','coverage','dist','.vite'));(temp/'node_modules').symlink_to(root/'node_modules',target_is_directory=True)
for name in ['package.json','bun.lock']:shutil.copy2(root/name,temp/name)
(target/'node_modules').symlink_to(root/'packages/v2/node_modules',target_is_directory=True)
path=target/'core/src/contracts/plugin-types.ts';original=path.read_text();changes=[
('required-optional-dependency','Partial<Dependencies<Tokens<M, "optional">>>','Dependencies<Tokens<M, "optional">>','manifest-helper-optional-needs-check.case'),
('accepted-extra-manifest-field','} & Record<Exclude<ManifestKeys<M>, keyof PluginManifest | "name" | "setup">, never>;','};','manifest-extra-field.case'),
('absent-table-permission','M[K] extends TokenMap ? ConsistentTokens<M[K]>','NonNullable<M[K]> extends TokenMap ? ConsistentTokens<NonNullable<M[K]>>','manifest-optional-table-grants-no-optional.case'),
('structural-helper-permission','readonly handle: TerminalCall<M>;','handle<K extends Keys<Tokens<M, "provides">, "chain">>(name: K, terminal: Implementation<Tokens<M, "provides">[K], M>, options?: RegistrationOptions): Result<Disposer>;','manifest-pick-cannot-infer-chain-handling.case'),
('union-branch-permission','ConsistentTokens<M[K]> : Record<never, never>','M[K] : Record<never, never>','manifest-union-kind-cannot-dispatch.case'),
('overlapping-protocol-union','IsUnion<ServiceOf<T>> extends true ? never : ','','manifest-overlapping-service-union-needs-narrowing.case'),
('union-hidden-extra-key','Record<Exclude<ManifestKeys<M>, keyof PluginManifest','Record<Exclude<keyof M, keyof PluginManifest','manifest-union-cannot-hide-extra-field.case'),
('widened-service-input','type ServiceOf<T> = T extends ServiceToken<infer S> ? S extends unknown ? ServiceFunctions<S> : never : never;','type ServiceOf<T> = T extends ServiceToken<infer S> ? S : never;','manifest-pick-cannot-widen-service-input.case')
]
for label,name,symptom in [('resource-wrapper-shortcut','PluginResource','manifest-resource-cannot-widen-service-input.case'),('implementation-wrapper-shortcut','PluginImplementations','manifest-implementation-cannot-widen-service-input.case')]:
 block=re.search(r'export type '+name+r'[\s\S]*?} : never;',original).group(0);restored=block.replace('= [M] extends [unknown] ? {','= {').replace('} : never;','} & {};');changes.append((label,block,restored,symptom))
entry=target/'core/src/index.ts';fixtures=target/'core/src/contracts/__test__/type-fixtures'
prefix='import { defineService } from '+json.dumps(str(entry))+';\nimport type { Context, CleanupContext, Invocation, ServiceToken, ChainToken, GuardToken, EventToken, Result, CoreFault, MethodSpec } from '+json.dumps(str(entry))+';\ndeclare const ctx: Context;\ndeclare const cleanup: CleanupContext;\ndeclare const service: ServiceToken<{ run(input: { text: string }): Promise<Result<number, { kind: "denied" }>> }>;\ndeclare const chain: ChainToken<string, number>;\ndeclare const guard: GuardToken<string>;\ndeclare const event: EventToken<string>;\n'
file=temp/'mutation-target.case.ts';results=[]
for label,before,after,symptom in changes:
 assert before in original,label
 case=(fixtures/symptom).read_text().replace('"__PUBLIC_ENTRY__"',json.dumps(str(entry))).replace('"__AUTHORING_FIXTURE__"',json.dumps(str(fixtures/'authoring-positive.ts')));file.write_text(prefix+case)
 args=['bun',str(root/'node_modules/typescript/bin/tsc'),'--ignoreConfig','--noEmit','--allowImportingTsExtensions','--strict','--skipLibCheck','--target','ESNext','--lib','ESNext,DOM','--module','ESNext','--moduleResolution','bundler',str(file)]
 normal=subprocess.run(args,cwd=target,capture_output=True,text=True,timeout=20);normal_output=normal.stdout+normal.stderr;diagnostics=re.findall(r'mutation-target.case.ts\((\d+),\d+\): error TS(\d+)',normal_output)
 assert normal.returncode!=0 and any(int(line)>=9 and int(code) not in [2307,2688,5097] for line,code in diagnostics),(label,normal_output)
 path.write_text(original.replace(before,after));mutant=subprocess.run(args,cwd=target,capture_output=True,text=True,timeout=20);mutant_output=mutant.stdout+mutant.stderr
 assert mutant.returncode==0 and not mutant_output.strip(),(label,mutant_output)
 results.append({'mutation':label,'regression':symptom,'baseline_rejected_api_usage':True,'mutant_accepted_api_usage':True,'rejected_by_api_type_assertion':True});path.write_text(original)
print(json.dumps(results,indent=2));shutil.rmtree(temp)
