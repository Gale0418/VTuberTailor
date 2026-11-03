import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve,join } from 'node:path';
import { describe,it,expect } from 'vitest';
import { createProject,loadProject } from '../src/project.js';
import { bakeNativeLayer,compactNativeLayerForExport,exportNativeCubism,nativeExporterSearchRoots,nativeLayerSampler,nativeCubismParameterId,nativeArtPositions } from '../src/cubism-native.js';
import { applyAuthoringOperations } from '../src/authoring.js';
import { artifactPath } from '../../../test/support/artifacts.js';

describe('native Cubism sampling',()=>{
  it('uses the configured root when the core is bundled',async()=>{
    const root=await mkdtemp(join(tmpdir(),'puppetloom-native-root-'));
    const cwd=await mkdtemp(join(tmpdir(),'puppetloom-native-cwd-'));
    const originalCwd=process.cwd();
    const previousConfig=process.env.PUPPETLOOM_NATIVE_EXPORT_CONFIG;
    try {
      const sourceDirectory=join(cwd,'tools','cubism-exporter'),configPath=join(root,'config.json');
      await mkdir(sourceDirectory,{recursive:true});
      const sourceHash=createHash('sha256');
      for(const file of ['Main.kt','Physics.kt','CoreProbe.kt','EditorProfile.kt']) {
        const source='unrelated cwd exporter source';
        await writeFile(join(sourceDirectory,file),source);
      }
      const sourceRoot=resolve('tools','cubism-exporter');
      for(const file of ['Main.kt','Physics.kt','CoreProbe.kt','EditorProfile.kt'])sourceHash.update(await readFile(join(sourceRoot,file)));
      await writeFile(configPath,JSON.stringify({java:'java',classpath:'',sourceSha256:sourceHash.digest('hex')}));
      process.chdir(cwd);
      process.env.PUPPETLOOM_NATIVE_EXPORT_CONFIG=configPath;
      // A bundled core chunk cannot infer the workspace root from its own import.meta.url;
      // an unrelated cwd must not win over the module-root ancestors.
      await expect(exportNativeCubism(join(root,'missing-project'),join(root,'export'))).rejects.toThrow('无法读取 PuppetLoom 项目');
    } finally {
      process.chdir(originalCwd);
      if(previousConfig===undefined)delete process.env.PUPPETLOOM_NATIVE_EXPORT_CONFIG;
      else process.env.PUPPETLOOM_NATIVE_EXPORT_CONFIG=previousConfig;
      await rm(root,{recursive:true,force:true});
      await rm(cwd,{recursive:true,force:true});
    }
  });
  it('prioritizes config ancestors and rejects a mismatched source hash',async()=>{
    const root=await mkdtemp(join(tmpdir(),'puppetloom-native-config-root-'));
    const cwd=await mkdtemp(join(tmpdir(),'puppetloom-native-other-cwd-'));
    const originalCwd=process.cwd();
    const previousConfig=process.env.PUPPETLOOM_NATIVE_EXPORT_CONFIG;
    try {
      const sourceDirectory=join(root,'tools','cubism-exporter'),configDirectory=join(root,'runtime','cubism-exporter'),configPath=join(configDirectory,'config.json');
      await mkdir(sourceDirectory,{recursive:true});
      await mkdir(configDirectory,{recursive:true});
      await mkdir(join(cwd,'tools','cubism-exporter'),{recursive:true});
      const sourceHash=createHash('sha256');
      for(const file of ['Main.kt','Physics.kt','CoreProbe.kt','EditorProfile.kt']) {
        const source='config ancestor synthetic exporter source';
        sourceHash.update(source);
        await writeFile(join(sourceDirectory,file),source);
        await writeFile(join(cwd,'tools','cubism-exporter',file),'unrelated cwd exporter source');
      }
      await writeFile(configPath,JSON.stringify({java:'java',classpath:'',sourceSha256:sourceHash.digest('hex')}));
      process.chdir(cwd);
      process.env.PUPPETLOOM_NATIVE_EXPORT_CONFIG=configPath;
      await expect(exportNativeCubism(join(root,'missing-project'),join(root,'correct-export'))).rejects.toThrow('无法读取 PuppetLoom 项目');

      await writeFile(configPath,JSON.stringify({java:'java',classpath:'',sourceSha256:'incorrect-source-hash'}));
      await expect(exportNativeCubism(join(root,'missing-project'),join(root,'incorrect-export'))).rejects.toThrow('格式转换器源码已更新');
    } finally {
      process.chdir(originalCwd);
      if(previousConfig===undefined)delete process.env.PUPPETLOOM_NATIVE_EXPORT_CONFIG;
      else process.env.PUPPETLOOM_NATIVE_EXPORT_CONFIG=previousConfig;
      await rm(root,{recursive:true,force:true});
      await rm(cwd,{recursive:true,force:true});
    }
  });
  it('does not discover an unconfigured exporter from the working directory',async()=>{
    const cwd=await mkdtemp(join(tmpdir(),'puppetloom-native-forged-cwd-'));
    const originalCwd=process.cwd();
    try {
      await mkdir(join(cwd,'tools','cubism-exporter'),{recursive:true});
      await mkdir(join(cwd,'runtime','cubism-exporter'),{recursive:true});
      for(const file of ['Main.kt','Physics.kt','CoreProbe.kt','EditorProfile.kt']) {
        await writeFile(join(cwd,'tools','cubism-exporter',file),'forged cwd exporter source');
      }
      await writeFile(join(cwd,'runtime','cubism-exporter','config.json'),JSON.stringify({java:'forged-java',classpath:'forged-classpath',sourceSha256:'0'.repeat(64)}));
      process.chdir(cwd);
      expect(nativeExporterSearchRoots()).not.toContain(cwd);
      expect(nativeExporterSearchRoots().some(candidate=>candidate===cwd||candidate.startsWith(`${cwd}/`))).toBe(false);
    } finally {
      process.chdir(originalCwd);
      await rm(cwd,{recursive:true,force:true});
    }
  });
  it('maps source IDs to stable, distinct Editor-compatible identifiers',()=>{
    expect(nativeCubismParameterId('ParamAngleX')).toBe('ParamAngleX');
    const ids=['param-head-yaw','param_head_yaw','眼睛','眼睛'.repeat(100)].map(nativeCubismParameterId);
    expect(new Set(ids).size).toBe(4);
    for(const id of ids)expect(id).toMatch(/^[A-Za-z_][A-Za-z0-9_]{0,62}$/);
    expect(nativeCubismParameterId('眼睛')).toBe(ids[2]);
  });
  it('retains combined keyforms, measures intermediate error, and never mutates source geometry',async()=>{
    const directory=artifactPath('native-cubism-sampling');
    await createProject({input:resolve('test/fixtures/semantic.psd'),output:directory});
    const original=await loadProject(directory),face=original.layers.find(l=>l.role==='face')!;
    const p=applyAuthoringOperations(original,[{op:'upsert-binding',binding:{id:'native-test',parameterIds:['param-head-yaw','param-head-pitch'],target:{kind:'layer',id:face.id},keyforms:[-1,0,1].flatMap(x=>[-1,0,1].map(y=>({values:[x,y],meshPointDeltas:{'0':{x:x*y*.001,y:0}}})))}}]);
    const before=JSON.stringify(p);const baked=bakeNativeLayer(p,p.layers.find(l=>l.id===face.id)!,.5);
    expect(baked.axes.map(a=>a.id)).toEqual(expect.arrayContaining(['param-head-yaw','param-head-pitch']));
    expect(baked.maxError.pixels).toBeLessThanOrEqual(.5);expect(JSON.stringify(p)).toBe(before);
    const cell=baked.cells.at(-1)!;
    const values=Object.fromEntries(baked.axes.map(a=>[a.id,a.keys.at(-1)!]));
    expect(cell.positions).toEqual(nativeLayerSampler(p,p.layers.find(l=>l.id===face.id)!)(values).positions);
  },120000);
  it('keeps texture placement affine when the neutral mesh is sculpted',async()=>{
    const directory=artifactPath('native-cubism-art-placement');
    await createProject({input:resolve('test/fixtures/semantic.psd'),output:directory});
    const project=await loadProject(directory),face=project.layers.find(l=>l.role==='face')!;
    const art=nativeArtPositions(project,face);
    face.mesh.points[0]!.x+=.02;
    const sculpted=nativeLayerSampler(project,face)({});
    expect(Math.abs(sculpted.positions[0]!-art[0]!)).toBeGreaterThan(1);
    expect(nativeArtPositions(project,face)).toEqual(art);
    // Absolute keyforms must still contain the sculpture; only the source art stays flat.
    expect(bakeNativeLayer(project,face).base.positions).toEqual(sculpted.positions);
  },120000);

  it('compacts only referenced native vertices and preserves sampled geometry/channels',async()=>{
    const directory=artifactPath('native-cubism-mesh-compaction');
    await createProject({input:resolve('test/fixtures/semantic.psd'),output:directory});
    const project=await loadProject(directory),face=project.layers.find(l=>l.role==='face')!;
    const points=[{x:.20,y:.20},{x:.80,y:.20},{x:.50,y:.45},{x:.10,y:.70},{x:.90,y:.70},{x:.50,y:.95}];
    const clip=project.layers.find(l=>l.id!==face.id)!;
    face.clipLayerId=clip.id; face.order=17; face.headPoseMode='keyforms'; face.deformerId='compact-rotation';
    face.generatedAsset={referenceId:'ref-compact',registrationId:'reg-compact',imageSha256:'a'.repeat(64),templateLayerId:'template-compact'};
    face.sourceLayerId='source-compact'; face.texture='textures/compact.png'; face.bounds={x:.11,y:.12,width:.73,height:.64};
    face.mesh={topology:'art',points,uvs:points.map(p=>({...p})),triangles:[4,2,0,0,2,4],influences:{head:[.1,.2,.3,.4,.5,.6],physics:[.6,.5,.4,.3,.2,.1]}};
    project.runtime.features={...project.runtime.features,headTurn:true,blink:true};
    project.runtime.poseField={kind:'ellipsoid-v1',center:{x:.5,y:.3},radiusX:.2,radiusY:.2,maxYawRadians:.3,maxPitchRadians:.2,perspective:.12};
    project.runtime.poseOcclusion={kind:'semantic-occlusion-v1',fadeStart:.58,farEyeOpacity:1,farBrowOpacity:1,farEarOpacity:.55,farSideHairOpacity:.72,sideHairDepthSwap:true};
    project.model.deformers=[{id:'compact-rotation',name:'compact rotation',kind:'rotation',pivot:{x:.5,y:.5}}];
    project.model.bindings=[
      {id:'compact-pose',parameterIds:['param-head-yaw','param-head-pitch'],target:{kind:'layer',id:face.id},keyforms:[-1,0,1].flatMap(x=>[-1,0,1].map(y=>({values:[x,y] as [number,number],meshPointDeltas:{'0':{x:x*.01,y:y*.01},'2':{x:x*.02,y:y*.02},'4':{x:x*.03,y:y*.03}}})))},
      {id:'compact-blink',parameterIds:['param-blink'],target:{kind:'layer',id:face.id},keyforms:[{values:[0] as [number],opacityMultiplier:1,drawOrderOffset:0},{values:[1] as [number],opacityMultiplier:.35,drawOrderOffset:4}]},
      {id:'compact-deformer',parameterIds:['param-head-roll'],target:{kind:'deformer',id:'compact-rotation'},keyforms:[{values:[-1] as [number],transform:{rotationDegrees:-5}},{values:[0] as [number],transform:{rotationDegrees:0}},{values:[1] as [number],transform:{rotationDegrees:5}}]}
    ];
    project.model.bindings[0]!.keyforms.forEach(keyform => { keyform.meshPointDeltas!['5']={x:.9,y:.9}; });
    const compact=compactNativeLayerForExport(project,face);
    expect(compact.compacted).toBe(true);
    expect(compact.newToOld).toEqual([0,2,4]);
    expect(compact.oldToNew).toEqual([0,-1,1,-1,2,-1]);
    expect(compact.layer.mesh.triangles).toEqual([2,1,0,0,1,2]);
    expect(compact.layer.clipLayerId).toBe(clip.id);
    expect(compact.layer.order).toBe(17);
    expect(compact.layer.deformerId).toBe('compact-rotation');
    expect(compact.layer.generatedAsset).toEqual(face.generatedAsset);
    expect(compact.layer.sourceLayerId).toBe(face.sourceLayerId);
    expect(compact.layer.texture).toBe(face.texture);
    expect(compact.layer.bounds).toEqual(face.bounds);
    expect(compact.layer.mesh.influences).toEqual({head:[.1,.3,.5],physics:[.6,.4,.2]});
    expect(compact.project.model.bindings[0]!.keyforms[0]!.meshPointDeltas).toEqual({'0':{x:-.01,y:-.01},'1':{x:-.02,y:-.02},'2':{x:-.03,y:-.03}});
    const sourceArt=nativeArtPositions(project,face),compactArt=nativeArtPositions(compact.project,compact.layer);
    expect(compactArt).toEqual([sourceArt[0]!,sourceArt[1]!,sourceArt[4]!,sourceArt[5]!,sourceArt[8]!,sourceArt[9]!]);
    for(const values of [
      {},
      {'param-head-yaw':-1,'param-head-pitch':-1},
      {'param-head-yaw':.5,'param-head-pitch':-.25},
      {'param-head-yaw':1,'param-head-pitch':1},
      {'param-blink':1}
    ]) {
      const source=nativeLayerSampler(project,face)(values),target=nativeLayerSampler(compact.project,compact.layer)(values);
      expect(target.opacity).toBeCloseTo(source.opacity,10);
      expect(target.order).toBeCloseTo(source.order,10);
      for(const [compactIndex,oldIndex] of compact.newToOld.entries()) {
        expect(target.positions[compactIndex*2]).toBeCloseTo(source.positions[oldIndex*2]!,10);
        expect(target.positions[compactIndex*2+1]).toBeCloseTo(source.positions[oldIndex*2+1]!,10);
      }
    }
    expect(face.mesh.points).toEqual(points);
  },120000);

  it('compacts an r69-scale art layer with dense orphan keyform deltas',async()=>{
    const directory=artifactPath('native-cubism-r69-scale-compaction');
    await createProject({input:resolve('test/fixtures/semantic.psd'),output:directory});
    const project=await loadProject(directory),layer=project.layers.find(l=>l.role==='eyeWhite')!;
    const points=Array.from({length:1069},(_,index)=>({x:.25+(index%37)*.005,y:.2+(index%29)*.006}));
    const uvs=points.map(point=>({...point}));
    const triangles:number[]=[];
    for(let index=0;index<69;index+=3)triangles.push(index,index+1,index+2);
    triangles.push(69,70,0);
    for(let index=triangles.length/3;index<110;index+=1)triangles.push(index%71,(index*7+1)%71,(index*13+2)%71);
    layer.mesh={topology:'art',points,uvs,triangles};
    layer.headPoseMode='keyforms';
    project.runtime.features={...project.runtime.features,headTurn:true};
    const denseDeltas=()=>Object.fromEntries(points.map((_,index)=>[String(index),{x:index*.000001,y:-index*.000001}]));
    project.model.bindings=[{id:'r69-dense-eye',parameterIds:['param-head-yaw','param-head-pitch'],target:{kind:'layer',id:layer.id},keyforms:[-1,0,1].flatMap(x=>[-1,0,1].map(y=>({values:[x,y] as [number,number],meshPointDeltas:denseDeltas()})))}];
    const compact=compactNativeLayerForExport(project,layer);
    expect(compact.compacted).toBe(true);
    expect(compact.newToOld).toHaveLength(71);
    expect(points.length-compact.newToOld.length).toBe(998);
    expect(compact.layer.mesh.points).toHaveLength(71);
    expect(compact.layer.mesh.triangles.every(index=>index>=0&&index<compact.layer.mesh.points.length)).toBe(true);
    expect(nativeArtPositions(compact.project,compact.layer)).toHaveLength(142);
    expect(compact.layer.mesh.uvs.flatMap(point=>[point.x,point.y])).toHaveLength(142);
    expect((compact.layer.mesh.points.length*2+2)*4).toBe((142+2)*4);
    for(const values of [{},{'param-head-yaw':-1,'param-head-pitch':1},{'param-head-yaw':.37,'param-head-pitch':-.41}]) {
      const source=nativeLayerSampler(project,layer)(values),target=nativeLayerSampler(compact.project,compact.layer)(values);
      expect(target.opacity).toBeCloseTo(source.opacity,10);
      expect(target.order).toBeCloseTo(source.order,10);
      for(const [compactIndex,oldIndex] of compact.newToOld.entries()) {
        expect(target.positions[compactIndex*2]).toBeCloseTo(source.positions[oldIndex*2]!,10);
        expect(target.positions[compactIndex*2+1]).toBeCloseTo(source.positions[oldIndex*2+1]!,10);
      }
    }
    expect(layer.mesh.points).toHaveLength(1069);
  },120000);

  it('preserves generic pose-field deformation and side order/opacity in compact views',async()=>{
    const directory=artifactPath('native-cubism-generic-pose-compaction');
    await createProject({input:resolve('test/fixtures/semantic.psd'),output:directory});
    const project=await loadProject(directory),face=project.layers.find(l=>l.role==='face')!;
    const headYaw=project.model.parameters.find(parameter=>parameter.semantic==='head-yaw')!.id;
    project.model.bindings=[];
    project.runtime.features={...project.runtime.features,headTurn:true};
    project.runtime.poseField={kind:'ellipsoid-v1',center:{x:.5,y:.3},radiusX:.2,radiusY:.2,maxYawRadians:.3,maxPitchRadians:.2,perspective:.12};
    project.runtime.poseOcclusion={kind:'semantic-occlusion-v1',fadeStart:.2,farEyeOpacity:.9,farBrowOpacity:.8,farEarOpacity:.4,farSideHairOpacity:.6,sideHairDepthSwap:true};
    const makeMesh=()=>({topology:'art' as const,points:[{x:.36,y:.24},{x:.64,y:.24},{x:.5,y:.55},{x:.2,y:.2}],uvs:[{x:0,y:0},{x:1,y:0},{x:.5,y:1},{x:0,y:0}],triangles:[0,1,2]});
    delete face.headPoseMode; face.mesh=makeMesh();
    const sideHair=structuredClone(face); sideHair.id='synthetic-side-hair'; sideHair.role='sideHair'; sideHair.side='left'; sideHair.order=face.order-1; sideHair.sourceName='synthetic side hair'; sideHair.mesh=makeMesh();
    const ear=structuredClone(face); ear.id='synthetic-ear'; ear.role='ear'; ear.side='left'; ear.order=face.order-2; ear.sourceName='synthetic ear'; ear.mesh=makeMesh();
    project.layers.push(sideHair,ear);
    for(const layer of [face,sideHair,ear]) {
      const compact=compactNativeLayerForExport(project,layer);
      expect(compact.compacted).toBe(true);
      for(const yaw of [-1,0,.47,1]) {
        const values={[headYaw]:yaw};
        const source=nativeLayerSampler(project,layer)(values),target=nativeLayerSampler(compact.project,compact.layer)(values);
        expect(target.opacity).toBeCloseTo(source.opacity,10);
        expect(target.order).toBeCloseTo(source.order,10);
        for(const [compactIndex,oldIndex] of compact.newToOld.entries()) {
          expect(target.positions[compactIndex*2]).toBeCloseTo(source.positions[oldIndex*2]!,10);
          expect(target.positions[compactIndex*2+1]).toBeCloseTo(source.positions[oldIndex*2+1]!,10);
        }
      }
    }
    expect(nativeLayerSampler(project,sideHair)({[headYaw]:1}).order).not.toBe(nativeLayerSampler(project,sideHair)({[headYaw]:0}).order);
    expect(nativeLayerSampler(project,sideHair)({[headYaw]:1}).opacity).toBeCloseTo(.6,5);
  },120000);

  it('falls back to the original mesh for hair, moving collision, and unknown indexed features',async()=>{
    const directory=artifactPath('native-cubism-mesh-compaction-fallback');
    await createProject({input:resolve('test/fixtures/semantic.psd'),output:directory});
    const project=await loadProject(directory),face=project.layers.find(l=>l.role==='face')!;
    face.mesh={topology:'art',points:[{x:.2,y:.2},{x:.8,y:.2},{x:.5,y:.8},{x:.1,y:.1}],uvs:[{x:.2,y:.2},{x:.8,y:.2},{x:.5,y:.8},{x:.1,y:.1}],triangles:[0,1,2]};
    const hairProject=structuredClone(project),hair=hairProject.layers.find(l=>l.id===face.id)!;
    hair.hairStrands=[{id:'strand',root:{x:.5,y:.2},tip:{x:.5,y:.8},width:.1,confidence:1,source:'corrected',physics:{stiffness:1,damping:1,segments:2,maxDisplacement:.1},weights:[1,1,1,0],release:[1,1,1,0]}];
    expect(compactNativeLayerForExport(hairProject,hair).compacted).toBe(false);
    const collisionProject=structuredClone(project),collisionLayer=collisionProject.layers.find(l=>l.id===face.id)!;
    collisionProject.runtime.constraints={motionLimits:[],collisions:[{id:'moving',name:'moving',movingLayerIds:[face.id],colliderLayerIds:[project.layers.find(l=>l.id!==face.id)!.id],padding:0,maxCorrection:.1,strength:1}]};
    expect(compactNativeLayerForExport(collisionProject,collisionLayer).reason).toMatch(/moving collision/);
    const unknownProject=structuredClone(project),unknownLayer=unknownProject.layers.find(l=>l.id===face.id)!;
    (unknownLayer.mesh as unknown as Record<string,unknown>).vertexLabels=['a','b','c','d'];
    expect(compactNativeLayerForExport(unknownProject,unknownLayer).reason).toMatch(/未知 vertex-indexed mesh/);
    const legacyProject=structuredClone(project),legacyLayer=legacyProject.layers.find(l=>l.id===face.id)!;
    delete (legacyLayer.mesh as unknown as Record<string,unknown>).topology;
    expect(compactNativeLayerForExport(legacyProject,legacyLayer).reason).toMatch(/非明確 art topology/);
    const gridProject=structuredClone(project),gridLayer=gridProject.layers.find(l=>l.id===face.id)!;
    gridLayer.mesh={topology:'grid',rows:2,cols:2,points:[{x:.2,y:.2},{x:.8,y:.2},{x:.5,y:.8},{x:.1,y:.1}],uvs:[{x:.2,y:.2},{x:.8,y:.2},{x:.5,y:.8},{x:.1,y:.1}],triangles:[0,1,2]};
    expect(compactNativeLayerForExport(gridProject,gridLayer).reason).toMatch(/非明確 art topology/);
  });
});

describe.skipIf(!existsSync('runtime/cubism-exporter/config.json'))('configured JVM native Cubism exporter',()=>{
  it.each(['4.2','5.3'] as const)('encodes runtime target %s independently of the editor profile',async(runtimeVersion)=>{
    const root=artifactPath(`native-cubism-${runtimeVersion}`),directory=join(root,'source');
    await createProject({input:resolve('test/fixtures/semantic.psd'),output:directory});
    const result=await exportNativeCubism(directory,join(root,'export'),{runtimeVersion,editorVersion:'5.4'});
    expect(result.editorVersion).toBe('5.4');expect(result.runtimeVersion).toBe(runtimeVersion);
    expect(result.verification.valid).toBe(true);
    // MOC format v4 = Cubism 4.2; v5 = Cubism 5.0; v6 = Cubism 5.3.
    expect((await readFile(result.moc3))[4]).toBe(runtimeVersion==='4.2'?4:6);
  },180000);
  it('writes real editable and runtime files, keeps the source revision, and refuses an occupied directory',async()=>{
    const root=artifactPath('native-cubism-export'),directory=join(root,'source'),output=join(root,'export');
    await createProject({input:resolve('test/fixtures/semantic.psd'),output:directory});
    const before=await readFile(join(directory,'calibration/current.json'));
    const result=await exportNativeCubism(directory,output);
    expect(result.verification.valid).toBe(true);expect(result.status).toBe('awaiting-visual-review');
    expect(result.editorVersion).toBe('5.3');expect(result.runtimeVersion).toBe('5.0');
    expect(Object.values(result.parameterIds).every(id=>/^[A-Za-z_][A-Za-z0-9_]{0,62}$/.test(id))).toBe(true);
    expect(Object.values(result.drawableIds).every(id=>/^[A-Za-z_][A-Za-z0-9_]{0,62}$/.test(id))).toBe(true);
    expect((await readFile(result.moc3)).subarray(0,4).toString()).toBe('MOC3');
    expect((await readFile(result.cmo3)).length).toBeGreaterThan(1000);
    expect(JSON.parse(await readFile(join(output,'codec-report.json'),'utf8')).readback).toBe(true);
    expect(await readFile(join(directory,'calibration/current.json'))).toEqual(before);
    await expect(exportNativeCubism(directory,output)).rejects.toThrow('已存在');
  },180000);
});
