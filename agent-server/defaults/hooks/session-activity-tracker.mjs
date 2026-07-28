#!/usr/bin/env node
// @cortex-hook-version 2026.6.24
// input:  stdin Claude Code PostToolUse event, node:fs
// output: Appends path-only records to session-activity JSONL
// pos:    PostToolUse Read/Edit/Write/Skill activity tracker

import { readFileSync, mkdirSync, appendFileSync } from 'fs';
import { join, resolve } from 'path';
import { fileURLToPath } from 'url';
import { homedir } from 'os';

const DATA_DIR = process.env.CORTEX_HOME
  ? resolve(process.env.CORTEX_HOME)
  : join(homedir(), '.cortex');

const MCP_REMOTE_EDIT_TOOL = 'mcp__cortex__remote_edit';
const MCP_REMOTE_WRITE_TOOL = 'mcp__cortex__remote_write';

function resolveDataDir() {
  const override = process.env.CORTEX_HOME;
  return override ? resolve(override) : DATA_DIR;
}

function resolveSessionId(payload) {
  const envSession = process.env.CORTEX_SESSION_ID?.trim();
  if (envSession) return envSession;

  const directSession = typeof payload.session_id === 'string' ? payload.session_id.trim() : '';
  if (directSession) return directSession;

  const camelSession = typeof payload.sessionId === 'string' ? payload.sessionId.trim() : '';
  if (camelSession) return camelSession;

  return null;
}

function getLogPath(sessionId) {
  const logsDir = join(resolveDataDir(), 'logs', 'session-activity');
  mkdirSync(logsDir, { recursive: true });
  return join(logsDir, `${sessionId}.jsonl`);
}

function isSkillSuccess(payload) {
  if (payload.is_error === true) return false;

  const response = payload.tool_response;
  if (response && typeof response === 'object') {
    if (response.success === false) return false;
    if (response.is_error === true) return false;
    if (response.error) return false;
  }

  const output = payload.tool_output;
  if (output && typeof output === 'object') {
    if (output.is_error === true) return false;
    if (output.error) return false;
  }

  return true;
}

function toRecord(payload, sessionId) {
  const toolName = payload.tool_name;
  if (toolName === 'Read') {
    const filePath = payload.tool_input?.file_path;
    if (!filePath) return null;
    return {
      ts: new Date().toISOString(),
      session_id: sessionId,
      tool: 'Read',
      event: 'read_file',
      file_path: resolve(filePath),
    };
  }

  if (toolName === 'Edit' || toolName === 'Write') {
    const filePath = payload.tool_input?.file_path;
    if (!filePath) return null;
    const isEdit = toolName === 'Edit';
    return {
      ts: new Date().toISOString(),
      session_id: sessionId,
      tool: toolName,
      event: isEdit ? 'edit_file' : 'write_file',
      file_path: resolve(filePath),
    };
  }

  if (toolName === MCP_REMOTE_EDIT_TOOL || toolName === MCP_REMOTE_WRITE_TOOL) {
    const filePath = payload.tool_input?.file_path;
    if (!filePath) return null;
    const isEdit = toolName === MCP_REMOTE_EDIT_TOOL;
    return {
      ts: new Date().toISOString(),
      session_id: sessionId,
      tool: isEdit ? 'Edit' : 'Write',
      event: isEdit ? 'edit_file' : 'write_file',
      file_path: filePath,
      device: payload.tool_input?.device,
    };
  }

  if (toolName === 'Skill') {
    const skill = payload.tool_input?.skill;
    if (!skill) return null;
    if (!isSkillSuccess(payload)) return null;
    return {
      ts: new Date().toISOString(),
      session_id: sessionId,
      tool: 'Skill',
      event: 'skill_use',
      skill: skill.toLowerCase(),
      success: true,
    };
  }

  return null;
}

function appendRecord(record) {
  const logPath = getLogPath(record.session_id);
  appendFileSync(logPath, `${JSON.stringify(record)}\n`);
}

export function processPayload(payload) {
  const sessionId = resolveSessionId(payload);
  if (!sessionId) return;

  const record = toRecord(payload, sessionId);
  if (!record) return;

  appendRecord(record);
}

function main() {
  let input = '';

  try {
    input = readFileSync(0, 'utf8');
  } catch {
    return;
  }

  if (!input.trim()) return;

  let payload;
  try {
    payload = JSON.parse(input);
  } catch {
    return;
  }

  processPayload(payload);
}

// Run directly when invoked as a hook script
const isMain = process.argv[1] && (
  resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))
);
if (isMain) {
  main();
}
