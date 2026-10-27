import fs from 'node:fs';
import { execFileSync } from 'node:child_process';

export function windowsTarget(bytes) {
  const pe = bytes.readUInt32LE(0x3c);
  if (bytes.toString('ascii', pe, pe + 4) !== 'PE\0\0') throw new Error('Invalid Windows executable');
  const arch = { 0x8664: 'x64', 0xaa64: 'arm64' }[bytes.readUInt16LE(pe + 4)];
  const info = bytes.indexOf(Buffer.from('bd04effe00000100', 'hex'));
  if (info < 0) throw new Error('Missing Windows executable version information');
  const high = bytes.readUInt32LE(info + 8), low = bytes.readUInt32LE(info + 12);
  return { platform: 'win32', arch, version: `v${high >>> 16}.${high & 65535}.${low >>> 16}` };
}

export function verifyTarget(executable, platform, arch, codeCache) {
  const bytes = fs.readFileSync(executable);
  const target = bytes.toString('ascii', 0, 2) === 'MZ' ? windowsTarget(bytes) : JSON.parse(execFileSync(executable,
    ['-p', 'JSON.stringify({platform:process.platform,arch:process.arch,version:process.version})'], { encoding: 'utf8' }));
  if (target.platform !== platform || target.arch !== arch) throw new Error(`Executable target mismatch: ${JSON.stringify(target)}`);
  if (target.version !== process.version) throw new Error(`SEA requires the same Node version: builder ${process.version}, executable ${target.version}`);
  if (codeCache && (platform !== process.platform || arch !== process.arch)) throw new Error('Cross-platform SEA cannot use code cache');
  return target;
}
