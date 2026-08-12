// lib/host-sandbox.ts
import { spawn as nodeSpawn } from "node:child_process";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import type { ReadableStream as NodeWebReadableStream } from "node:stream/web";
import { pipeline } from "node:stream/promises";
import type { SandboxSession } from "eve/sandbox";

export interface HostProcess {
  readonly pid?: number;
  readonly stdout: ReadableStream<Uint8Array>;
  readonly stderr: ReadableStream<Uint8Array>;
  wait(): Promise<{ exitCode: number }>;
  kill(): Promise<void>;
}

export interface HostSpawnOptions {
  command: string;
  workingDirectory?: string;
  env?: Record<string, string>;
  abortSignal?: AbortSignal;
}

/** A live sandbox session rooted at `root`, backed by the real host. */
export function createHostSession(root: string, opts: { id: string; track: Set<HostProcess> }): SandboxSession {
  const resolvePath = (p: string): string => (path.isAbsolute(p) ? p : path.resolve(root, p));

  const spawn = async (o: HostSpawnOptions): Promise<HostProcess> => {
    const child = nodeSpawn(o.command, {
      cwd: o.workingDirectory ?? root,
      env: o.env ? { ...process.env, ...o.env } : process.env,
      stdio: ["inherit", "pipe", "pipe"],
      shell: true,
      ...(o.abortSignal ? { signal: o.abortSignal } : {}),
    });
    const handle: HostProcess = {
      pid: child.pid,
      stdout: Readable.toWeb(child.stdout!) as unknown as ReadableStream<Uint8Array>,
      stderr: Readable.toWeb(child.stderr!) as unknown as ReadableStream<Uint8Array>,
      wait: () =>
        new Promise((resolve, reject) => {
          child.once("error", reject);
          child.once("exit", (code) => {
            opts.track.delete(handle);
            resolve({ exitCode: code ?? -1 });
          });
        }),
      kill: async () => {
        child.kill("SIGKILL");
      },
    };
    opts.track.add(handle);
    return handle;
  };

  const collect = async (r: ReadableStream<Uint8Array>): Promise<string> => {
    const chunks: Uint8Array[] = [];
    const reader = r.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
    }
    const merged = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
    let off = 0;
    for (const c of chunks) {
      merged.set(c, off);
      off += c.length;
    }
    return new TextDecoder().decode(merged);
  };

  const readBuffer = async (p: string, signal?: AbortSignal): Promise<Uint8Array | null> => {
    const fp = resolvePath(p);
    try {
      return await readFile(fp, { signal });
    } catch {
      return null;
    }
  };

  return {
    id: opts.id,
    resolvePath,
    setNetworkPolicy: async () => {},
    removePath: async (o) => {
      await rm(resolvePath(o.path), { force: o.force, recursive: o.recursive });
    },
    spawn,
    run: async (o) => {
      const proc = await spawn(o);
      const [stdout, stderr, { exitCode }] = await Promise.all([collect(proc.stdout), collect(proc.stderr), proc.wait()]);
      return { exitCode, stdout, stderr };
    },
    readFile: async (o) => {
      const fp = resolvePath(o.path);
      try {
        await stat(fp);
      } catch {
        return null;
      }
      return Readable.toWeb(createReadStream(fp)) as unknown as ReadableStream<Uint8Array>;
    },
    readBinaryFile: async (o) => await readBuffer(o.path, o.abortSignal),
    readTextFile: async (o) => {
      const data = await readBuffer(o.path, o.abortSignal);
      if (data === null) return null;
      const text =
        o.encoding === undefined || o.encoding === "utf-8"
          ? new TextDecoder("utf-8", { fatal: true }).decode(data)
          : Buffer.from(data).toString(o.encoding as BufferEncoding);
      if (o.startLine === undefined && o.endLine === undefined) return text;
      const lines = text.split("\n");
      const start = (o.startLine ?? 1) - 1;
      const end = o.endLine === undefined ? lines.length : o.endLine;
      return lines.slice(Math.max(0, start), end).join("\n");
    },
    writeFile: async (o) => {
      const fp = resolvePath(o.path);
      await mkdir(path.dirname(fp), { recursive: true });
      await pipeline(Readable.fromWeb(o.content as unknown as NodeWebReadableStream), createWriteStream(fp));
    },
    writeBinaryFile: async (o) => {
      const fp = resolvePath(o.path);
      await mkdir(path.dirname(fp), { recursive: true });
      await writeFile(fp, o.content);
    },
    writeTextFile: async (o) => {
      const fp = resolvePath(o.path);
      await mkdir(path.dirname(fp), { recursive: true });
      await writeFile(fp, o.content, { encoding: o.encoding as BufferEncoding | undefined });
    },
  };
}
