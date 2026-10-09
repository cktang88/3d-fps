// Append THREE AnimationClip JSONs (tracks named by sanitized node names) to a GLB.
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import fs from 'node:fs';
const [, , inFile, clipsFile, outFile] = process.argv;
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
const doc = await io.read(inFile);
const root = doc.getRoot(), buffer = root.listBuffers()[0];
const sanitize = (n) => n.replace(/\s/g, '_').replace(/[\[\]\.:\/]/g, '');
const nodes = new Map(root.listNodes().map((n) => [sanitize(n.getName()), n]));
const clips = JSON.parse(fs.readFileSync(clipsFile, 'utf8'));
for (const old of root.listAnimations()) if (old.getName().startsWith('mocap_')) old.dispose();
for (const c of clips) {
  const anim = doc.createAnimation(c.name);
  for (const t of c.tracks) {
    const dot = t.name.lastIndexOf('.'), nodeName = t.name.slice(0, dot), prop = t.name.slice(dot + 1);
    const node = nodes.get(nodeName); if (!node) { console.log('missing node', nodeName); continue; }
    const path = prop === 'quaternion' ? 'rotation' : prop === 'position' ? 'translation' : 'scale';
    const input = doc.createAccessor().setType('SCALAR').setArray(new Float32Array(t.times)).setBuffer(buffer);
    const output = doc.createAccessor().setType(path === 'rotation' ? 'VEC4' : 'VEC3').setArray(new Float32Array(t.values)).setBuffer(buffer);
    const sampler = doc.createAnimationSampler().setInput(input).setOutput(output).setInterpolation('LINEAR');
    anim.addSampler(sampler).addChannel(doc.createAnimationChannel().setTargetNode(node).setTargetPath(path).setSampler(sampler));
  }
}
await io.write(outFile, doc);
console.log('ok', clips.length, fs.statSync(outFile).size);
