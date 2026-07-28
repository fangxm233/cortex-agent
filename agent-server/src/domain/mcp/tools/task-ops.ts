// input:  McpServer, webhook proxy, image processing
// output: Compact remote operation tool registrations
// pos:    MCP tools for remote device operations via cortex-client
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { pathToFileURL } from 'url';
import { WORKSPACE_DIR } from '@core/utils.js';
import { cortexMDContentBlocks, type CortexMDEntry } from './cortex-md.js';

// Remote device commands proxied through app.ts webhook (separate process, no shared memory with client-manager)
const WEBHOOK_BASE = `http://127.0.0.1:${process.env.WEBHOOK_PORT || '3001'}`;
// Bearer token for the webhook auth gate. Inherited from the daemon's env (see core/auth.ts).
const webhookAuthHeader = (): Record<string, string> => ({ 'x-cortex-token': process.env.CORTEX_WEBHOOK_TOKEN || '' });

async function proxyGetOnlineDevices(): Promise<string[]> {
  const res = await fetch(`${WEBHOOK_BASE}/webhook/devices`, { headers: webhookAuthHeader() });
  const data = await res.json() as any;
  return data.devices || [];
}

async function proxySendCommand(device: string, action: string, params: Record<string, any>, timeout?: number): Promise<any> {
  const res = await fetch(`${WEBHOOK_BASE}/webhook/remote-command`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...webhookAuthHeader() },
    body: JSON.stringify({ device, action, params, timeout }),
  });
  const data = await res.json() as any;
  if (!data.success) throw new Error(data.error || 'Command failed');
  return data.data;
}

async function deviceListDescription(): Promise<string> {
  const devices = await proxyGetOnlineDevices();
  if (devices.length === 0) return 'No devices currently online.';
  return `Online devices: ${devices.join(', ')}`;
}

/** Cross-platform absolute-path check (server runs on Linux but validates paths for Windows clients). */
function isAbsoluteFilePath(p: string): boolean {
  if (path.isAbsolute(p)) return true;
  // Windows absolute: D:\, D:/, etc.
  if (/^[A-Za-z]:[/\\]/.test(p)) return true;
  return false;
}

// --- Tool result persistence ---
// When tool output exceeds a character threshold, save full output to a local
// file and return a pointer + preview. Prevents context window explosion while
// keeping full results accessible via Read tool.
// remote_read excluded (Infinity) — self-bounds via word-count error on client.

const TOOL_RESULT_DIR = path.join(WORKSPACE_DIR, 'tool-results');

const RESULT_SIZE_THRESHOLDS: Record<string, number> = {
  remote_bash: 30_000,
  remote_grep: 20_000,
  remote_glob: 100_000,
  remote_read: Infinity,
};

function persistLargeResult(toolName: string, text: string): string {
  const threshold = RESULT_SIZE_THRESHOLDS[toolName] ?? 30_000;
  if (text.length <= threshold) return text;

  fs.mkdirSync(TOOL_RESULT_DIR, { recursive: true });
  const id = `${toolName}-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
  const filePath = path.join(TOOL_RESULT_DIR, `${id}.txt`);
  fs.writeFileSync(filePath, text, 'utf8');

  const sizeKB = (text.length / 1024).toFixed(2);
  const preview = text.slice(0, 2000);

  return [
    '<persisted-output>',
    `Output too large (${sizeKB} KB). Full output saved to local file:`,
    `  ${filePath}`,
    '',
    'Preview (first 2 KB):',
    preview,
    '...',
    '</persisted-output>',
  ].join('\n');
}

// --- Image processing pipeline ---
// sharp — optional image processing (resize/compress for token budget)
let sharpModule: typeof import('sharp') | null = null;
try {
  sharpModule = (await import('sharp')).default as any;
} catch {
  // sharp not installed — image reads will pass through raw base64
}

const IMAGE_TOKEN_BUDGET = 25_000;
const IMAGE_MAX_LONG_SIDE = 1568;

function estimateTokens(base64Length: number): number {
  return Math.ceil(base64Length * 0.125);
}

interface ProcessedImage {
  data: string;
  mimeType: string;
  width: number;
  height: number;
}

async function processImage(
  rawBase64: string,
  mimeType: string,
  origWidth?: number,
  origHeight?: number,
): Promise<ProcessedImage> {
  if (!sharpModule) {
    return { data: rawBase64, mimeType, width: origWidth || 0, height: origHeight || 0 };
  }

  const inputBuf = Buffer.from(rawBase64, 'base64');
  const meta = await sharpModule(inputBuf).metadata();
  let w = meta.width || origWidth || 0;
  let h = meta.height || origHeight || 0;
  let currentMime = mimeType;

  // Step 1: Standard resize — long side > 1568px → scale down
  const longSide = Math.max(w, h);
  let resizedBuf: Buffer<ArrayBufferLike> = inputBuf;
  if (longSide > IMAGE_MAX_LONG_SIDE) {
    const scale = IMAGE_MAX_LONG_SIDE / longSide;
    w = Math.round(w * scale);
    h = Math.round(h * scale);
    resizedBuf = await sharpModule(inputBuf).resize(w, h, { fit: 'inside', withoutEnlargement: true }).toBuffer();
  }

  // Step 2: Initial encode
  let outputBuf: Buffer<ArrayBufferLike>;
  if (currentMime === 'image/png') {
    outputBuf = await sharpModule(resizedBuf).png({ compressionLevel: 6 }).toBuffer();
  } else if (currentMime === 'image/webp') {
    outputBuf = await sharpModule(resizedBuf).webp({ quality: 85 }).toBuffer();
  } else {
    outputBuf = await sharpModule(resizedBuf).jpeg({ quality: 85 }).toBuffer();
    currentMime = 'image/jpeg';
  }

  let base64 = outputBuf.toString('base64');
  let tokens = estimateTokens(base64.length);

  // Step 3: Aggressive compression if over budget
  if (tokens > IMAGE_TOKEN_BUDGET) {
    // PNG → JPEG conversion first
    if (currentMime === 'image/png' || currentMime === 'image/webp') {
      outputBuf = await sharpModule(outputBuf).jpeg({ quality: 80 }).toBuffer();
      currentMime = 'image/jpeg';
      base64 = outputBuf.toString('base64');
      tokens = estimateTokens(base64.length);
    }

    // Reduce quality iteratively
    const qualitySteps = [70, 55, 40, 30];
    for (const q of qualitySteps) {
      if (tokens <= IMAGE_TOKEN_BUDGET) break;
      outputBuf = await sharpModule(resizedBuf)
        .resize(w, h, { fit: 'inside', withoutEnlargement: true })
        .jpeg({ quality: q })
        .toBuffer();
      currentMime = 'image/jpeg';
      base64 = outputBuf.toString('base64');
      tokens = estimateTokens(base64.length);
    }

    // Reduce dimensions if still over budget
    const dimScaleSteps = [0.75, 0.5, 0.35];
    for (const s of dimScaleSteps) {
      if (tokens <= IMAGE_TOKEN_BUDGET) break;
      const newW = Math.round(w * s);
      const newH = Math.round(h * s);
      outputBuf = await sharpModule(inputBuf)
        .resize(newW, newH, { fit: 'inside', withoutEnlargement: true })
        .jpeg({ quality: 30 })
        .toBuffer();
      base64 = outputBuf.toString('base64');
      tokens = estimateTokens(base64.length);
    }
  }

  // Final dimensions
  const finalMeta = await sharpModule(outputBuf).metadata();
  return {
    data: base64,
    mimeType: currentMime,
    width: finalMeta.width || w,
    height: finalMeta.height || h,
  };
}

export function registerTaskOpsTools(server: McpServer): void {

  // --- remote_bash ---

  server.tool(
    'remote_bash',
    'Execute a shell command on a remote device via cortex-client. On Windows devices, commands run through git-bash.',
    {
      device: z.string().describe('Target device name (e.g. "server", "workstation", "local")'),
      command: z.string().describe('Shell command to execute'),
      timeout: z.number().max(600000).optional().describe('Timeout in milliseconds (default: 120000, max: 600000)'),
      description: z.string().optional().describe('Description of what the command does (for logging)'),
      run_in_background: z.boolean().optional().describe('Run command in background, return PID immediately'),
    },
    async ({ device, command, timeout, description, run_in_background }: {
      device: string; command: string; timeout?: number; description?: string; run_in_background?: boolean;
    }) => {
      try {
        const effectiveTimeout = timeout || 120000;
        const result = await proxySendCommand(device, 'bash', {
          command, timeout: effectiveTimeout, run_in_background: run_in_background || false,
        }, effectiveTimeout + 5000);
        const parts = [];
        if (result.stdout) parts.push(result.stdout);
        if (result.stderr) parts.push(`[stderr]\n${result.stderr}`);
        if (result.exitCode !== 0) parts.push(`[exit code: ${result.exitCode}]`);
        const rawText = parts.join('\n') || '(no output)';
        const text = persistLargeResult('remote_bash', rawText);
        const hasError = result.exitCode !== undefined && result.exitCode !== 0;
        return { content: [{ type: 'text', text }], ...(hasError ? { isError: true } : {}) };
      } catch (e) {
        return { content: [{ type: 'text', text: `remote_bash error: ${(e as Error).message}` }], isError: true };
      }
    }
  );

  // --- remote_read ---

  server.tool(
    'remote_read',
    'Read a file from a remote device. Returns file contents with line numbers. Supports image files (PNG, JPEG, GIF, WebP, BMP) which are returned as inline images. Supports PDF files (.pdf) which are returned as inline documents. File path must be absolute.',
    {
      device: z.string().describe('Target device name'),
      file_path: z.string().describe('Absolute path to the file to read'),
      offset: z.number().optional().describe('Line number to start reading from (0-based)'),
      limit: z.number().optional().describe('Number of lines to read'),
    },
    { readOnlyHint: true },
    async ({ device, file_path, offset, limit }: {
      device: string; file_path: string; offset?: number; limit?: number;
    }) => {
      try {
        if (!isAbsoluteFilePath(file_path)) {
          return { content: [{ type: 'text', text: 'file_path must be absolute' }], isError: true };
        }
        const result = await proxySendCommand(device, 'read', { file_path, offset, limit });
        const cmdBlocks = cortexMDContentBlocks(device, result.cortexMDs, file_path);

        // Image response path
        if (result.image) {
          const { data, mimeType, width, height, originalSize } = result.image;
          try {
            const processed = await processImage(data, mimeType, width, height);
            const tokens = estimateTokens(processed.data.length);

            const metaParts = [
              `Image: ${file_path}`,
              `Original: ${width || '?'}x${height || '?'} ${mimeType} (${(originalSize / 1024).toFixed(1)} KB)`,
            ];
            if (processed.width !== width || processed.height !== height || processed.mimeType !== mimeType) {
              metaParts.push(`Processed: ${processed.width}x${processed.height} ${processed.mimeType} (~${tokens} tokens)`);
            } else {
              metaParts.push(`~${tokens} tokens`);
            }

            return {
              content: [
                { type: 'text', text: metaParts.join('\n') },
                { type: 'image', data: processed.data, mimeType: processed.mimeType },
                ...cmdBlocks,
              ],
            };
          } catch (imgErr) {
            return {
              content: [
                {
                  type: 'text',
                  text: `Image detected (${mimeType}, ${width || '?'}x${height || '?'}, ${(originalSize / 1024).toFixed(1)} KB) but processing failed: ${(imgErr as Error).message}`,
                },
                ...cmdBlocks,
              ],
            };
          }
        }

        // PDF response path — return as EmbeddedResource blob
        if (result.pdf) {
          const { data, originalSize } = result.pdf;
          return {
            content: [
              { type: 'text', text: `PDF: ${file_path} (${(originalSize / 1024).toFixed(1)} KB)` },
              {
                type: 'resource' as const,
                resource: {
                  uri: pathToFileURL(file_path).href,
                  mimeType: 'application/pdf',
                  blob: data,
                },
              },
              ...cmdBlocks,
            ],
          };
        }

        // Text response path
        return { content: [{ type: 'text', text: result.content || '(empty file)' }, ...cmdBlocks] };
      } catch (e) {
        return { content: [{ type: 'text', text: `remote_read error: ${(e as Error).message}` }], isError: true };
      }
    }
  );

  // --- remote_write ---

  server.tool(
    'remote_write',
    'Write content to a file on a remote device. Creates parent directories if needed. File path must be absolute.',
    {
      device: z.string().describe('Target device name'),
      file_path: z.string().describe('Absolute path to the file to write'),
      content: z.string().describe('Content to write to the file'),
    },
    async ({ device, file_path, content }: {
      device: string; file_path: string; content: string;
    }) => {
      try {
        if (!isAbsoluteFilePath(file_path)) {
          return { content: [{ type: 'text', text: 'file_path must be absolute' }], isError: true };
        }
        const result = await proxySendCommand(device, 'write', { file_path, content });
        const cmdBlocks = cortexMDContentBlocks(device, result?.cortexMDs, file_path);
        return {
          content: [{ type: 'text', text: `File written: ${file_path}` }, ...cmdBlocks],
        };
      } catch (e) {
        return { content: [{ type: 'text', text: `remote_write error: ${(e as Error).message}` }], isError: true };
      }
    }
  );

  // --- remote_edit ---

  server.tool(
    'remote_edit',
    'Edit a file on a remote device by replacing a string. The old_string must be unique in the file (unless replace_all is true). File path must be absolute.',
    {
      device: z.string().describe('Target device name'),
      file_path: z.string().describe('Absolute path to the file to edit'),
      old_string: z.string().describe('The text to replace'),
      new_string: z.string().describe('The replacement text'),
      replace_all: z.boolean().optional().describe('Replace all occurrences (default: false)'),
    },
    async ({ device, file_path, old_string, new_string, replace_all }: {
      device: string; file_path: string; old_string: string; new_string: string; replace_all?: boolean;
    }) => {
      try {
        if (!isAbsoluteFilePath(file_path)) {
          return { content: [{ type: 'text', text: 'file_path must be absolute' }], isError: true };
        }
        const result = await proxySendCommand(device, 'edit', { file_path, old_string, new_string, replace_all: replace_all || false });
        const cmdBlocks = cortexMDContentBlocks(device, result?.cortexMDs, file_path);
        return {
          content: [{ type: 'text', text: `File edited: ${file_path}` }, ...cmdBlocks],
        };
      } catch (e) {
        return { content: [{ type: 'text', text: `remote_edit error: ${(e as Error).message}` }], isError: true };
      }
    }
  );

  // --- remote_glob ---

  server.tool(
    'remote_glob',
    'Find files matching a glob pattern on a remote device. Returns a list of matching file paths.',
    {
      device: z.string().describe('Target device name'),
      pattern: z.string().describe('Glob pattern to match files against'),
      path: z.string().optional().describe('Directory to search in (absolute path)'),
    },
    { readOnlyHint: true },
    async ({ device, pattern, path: searchPath }: {
      device: string; pattern: string; path?: string;
    }) => {
      try {
        const result = await proxySendCommand(device, 'glob', { pattern, path: searchPath });
        const files = result.files || [];
        if (files.length === 0) {
          return { content: [{ type: 'text', text: 'No files matched the pattern.' }] };
        }
        let output = files.join('\n');
        if (result.truncated) {
          output += `\n[... truncated at ${files.length} results]`;
        }
        const text = persistLargeResult('remote_glob', output);
        return { content: [{ type: 'text', text }] };
      } catch (e) {
        return { content: [{ type: 'text', text: `remote_glob error: ${(e as Error).message}` }], isError: true };
      }
    }
  );

  // --- remote_grep ---

  server.tool(
    'remote_grep',
    'Search file contents on a remote device using ripgrep. Returns matching lines or file paths.',
    {
      device: z.string().describe('Target device name'),
      pattern: z.string().describe('Regex pattern to search for'),
      path: z.string().optional().describe('File or directory to search in'),
      glob: z.string().optional().describe('Glob pattern to filter files (e.g. "*.ts", "*.{ts,tsx}")'),
      type: z.string().optional().describe('File type to search (e.g. "js", "py", "rust")'),
      output_mode: z.enum(['content', 'files_with_matches', 'count']).optional().describe('Output mode (default: files_with_matches)'),
      '-A': z.number().optional().describe('Lines to show after each match'),
      '-B': z.number().optional().describe('Lines to show before each match'),
      '-C': z.number().optional().describe('Context lines before and after each match'),
      context: z.number().optional().describe('Alias for -C'),
      '-i': z.boolean().optional().describe('Case insensitive search'),
      '-n': z.boolean().optional().describe('Show line numbers (default: true for content mode)'),
      head_limit: z.number().optional().describe('Limit output entries (default: 250, 0 for unlimited)'),
      offset: z.number().optional().describe('Skip first N entries before applying head_limit'),
      multiline: z.boolean().optional().describe('Enable multiline matching (pattern can span lines)'),
    },
    { readOnlyHint: true },
    async ({ device, pattern, path: searchPath, glob: globFilter, type, output_mode, context: ctxLines, head_limit, offset, multiline, ...flags }: {
      device: string; pattern: string; path?: string; glob?: string; type?: string;
      output_mode?: string; context?: number; head_limit?: number; offset?: number;
      multiline?: boolean; [key: string]: any;
    }) => {
      try {
        const result = await proxySendCommand(device, 'grep', {
          pattern,
          path: searchPath,
          glob: globFilter,
          type,
          output_mode,
          '-A': flags['-A'],
          '-B': flags['-B'],
          '-C': flags['-C'],
          context: ctxLines,
          '-i': flags['-i'],
          '-n': flags['-n'],
          head_limit,
          offset,
          multiline,
        });
        const rawText = result.output || '(no matches)';
        const text = persistLargeResult('remote_grep', rawText);
        return { content: [{ type: 'text', text }] };
      } catch (e) {
        return { content: [{ type: 'text', text: `remote_grep error: ${(e as Error).message}` }], isError: true };
      }
    }
  );
}
