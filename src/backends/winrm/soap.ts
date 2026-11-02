import { randomUUID } from 'node:crypto';

export const NS = {
  s: 'http://www.w3.org/2003/05/soap-envelope',
  wsa: 'http://schemas.xmlsoap.org/ws/2004/08/addressing',
  wsman: 'http://schemas.dmtf.org/wbem/wsman/1/wsman.xsd',
  rsp: 'http://schemas.microsoft.com/wbem/wsman/1/windows/shell',
};

export const RESOURCE_CMD = 'http://schemas.microsoft.com/wbem/wsman/1/windows/shell/cmd';
export const ACTION = {
  create: 'http://schemas.xmlsoap.org/ws/2004/09/transfer/Create',
  delete: 'http://schemas.xmlsoap.org/ws/2004/09/transfer/Delete',
  command: 'http://schemas.microsoft.com/wbem/wsman/1/windows/shell/Command',
  receive: 'http://schemas.microsoft.com/wbem/wsman/1/windows/shell/Receive',
  send: 'http://schemas.microsoft.com/wbem/wsman/1/windows/shell/Send',
  signal: 'http://schemas.microsoft.com/wbem/wsman/1/windows/shell/Signal',
};
export const SIGNAL = {
  terminate: 'http://schemas.microsoft.com/wbem/wsman/1/windows/shell/signal/terminate',
  ctrlC: 'http://schemas.microsoft.com/wbem/wsman/1/windows/shell/signal/ctrl_c',
};
export const COMMAND_DONE = 'http://schemas.microsoft.com/wbem/wsman/1/windows/shell/CommandState/Done';

export function xmlEscape(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

export function xmlUnescape(s: string): string {
  return s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d))).replace(/&amp;/g, '&');
}

export interface EnvelopeOptions {
  to: string;
  action: string;
  shellId?: string;
  options?: Record<string, string>;
  body: string;
  operationTimeoutSec?: number;
}

export function envelope(o: EnvelopeOptions): string {
  const selector = o.shellId ? `<wsman:SelectorSet><wsman:Selector Name="ShellId">${xmlEscape(o.shellId)}</wsman:Selector></wsman:SelectorSet>` : '';
  const opts = o.options
    ? `<wsman:OptionSet>${Object.entries(o.options).map(([k, v]) => `<wsman:Option Name="${xmlEscape(k)}">${xmlEscape(v)}</wsman:Option>`).join('')}</wsman:OptionSet>`
    : '';
  return (
    `<?xml version="1.0" encoding="utf-8"?>` +
    `<s:Envelope xmlns:s="${NS.s}" xmlns:wsa="${NS.wsa}" xmlns:wsman="${NS.wsman}" xmlns:rsp="${NS.rsp}">` +
    `<s:Header>` +
    `<wsa:To>${xmlEscape(o.to)}</wsa:To>` +
    `<wsman:ResourceURI s:mustUnderstand="true">${RESOURCE_CMD}</wsman:ResourceURI>` +
    `<wsa:ReplyTo><wsa:Address s:mustUnderstand="true">http://schemas.xmlsoap.org/ws/2004/08/addressing/role/anonymous</wsa:Address></wsa:ReplyTo>` +
    `<wsa:Action s:mustUnderstand="true">${o.action}</wsa:Action>` +
    `<wsman:MaxEnvelopeSize s:mustUnderstand="true">512000</wsman:MaxEnvelopeSize>` +
    `<wsa:MessageID>uuid:${randomUUID().toUpperCase()}</wsa:MessageID>` +
    `<wsman:Locale xml:lang="en-US" s:mustUnderstand="false"/>` +
    `<wsman:OperationTimeout>PT${o.operationTimeoutSec ?? 20}S</wsman:OperationTimeout>` +
    selector +
    opts +
    `</s:Header><s:Body>${o.body}</s:Body></s:Envelope>`
  );
}

export function createShellBody(): string {
  return `<rsp:Shell><rsp:InputStreams>stdin</rsp:InputStreams><rsp:OutputStreams>stdout stderr</rsp:OutputStreams></rsp:Shell>`;
}

export function commandBody(command: string, args: string): string {
  return `<rsp:CommandLine><rsp:Command>${xmlEscape(command)}</rsp:Command>${args ? `<rsp:Arguments>${xmlEscape(args)}</rsp:Arguments>` : ''}</rsp:CommandLine>`;
}

export function receiveBody(commandId: string): string {
  return `<rsp:Receive><rsp:DesiredStream CommandId="${xmlEscape(commandId)}">stdout stderr</rsp:DesiredStream></rsp:Receive>`;
}

export function sendBody(commandId: string, data: Buffer, end: boolean): string {
  return `<rsp:Send><rsp:Stream Name="stdin" CommandId="${xmlEscape(commandId)}"${end ? ' End="true"' : ''}>${data.toString('base64')}</rsp:Stream></rsp:Send>`;
}

export function signalBody(commandId: string, code: string): string {
  return `<rsp:Signal CommandId="${xmlEscape(commandId)}"><rsp:Code>${code}</rsp:Code></rsp:Signal>`;
}

function tagText(xml: string, local: string): string | undefined {
  const m = xml.match(new RegExp(`<(?:\\w+:)?${local}(?:\\s[^>]*)?>([\\s\\S]*?)</(?:\\w+:)?${local}>`));
  return m ? xmlUnescape(m[1]!.trim()) : undefined;
}

export function parseShellId(xml: string): string | undefined {
  return tagText(xml, 'ShellId') ?? xml.match(/<(?:\w+:)?Selector Name="ShellId">([^<]+)</)?.[1];
}

export function parseCommandId(xml: string): string | undefined {
  return tagText(xml, 'CommandId');
}

export interface ReceiveChunk {
  stdout: Buffer;
  stderr: Buffer;
  done: boolean;
  exitCode?: number;
}

export function parseReceive(xml: string): ReceiveChunk {
  const out: Buffer[] = [];
  const err: Buffer[] = [];
  const re = /<(?:\w+:)?Stream\s+([^>]*?)(?:\/>|>([\s\S]*?)<\/(?:\w+:)?Stream>)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml))) {
    const name = m[1]!.match(/Name="(\w+)"/)?.[1];
    const data = m[2] ? Buffer.from(m[2].trim(), 'base64') : Buffer.alloc(0);
    if (name === 'stdout') out.push(data);
    else if (name === 'stderr') err.push(data);
  }
  const state = xml.match(/<(?:\w+:)?CommandState\s[^>]*State="([^"]+)"/)?.[1];
  const exit = tagText(xml, 'ExitCode');
  return { stdout: Buffer.concat(out), stderr: Buffer.concat(err), done: state === COMMAND_DONE, exitCode: exit !== undefined ? Number(exit) : undefined };
}

export function parseFault(xml: string): { code?: string; message: string } | undefined {
  if (!/<(?:\w+:)?Fault[\s>]/.test(xml)) return undefined;
  const code = xml.match(/<(?:\w+:)?WSManFault[^>]*Code="(\d+)"/)?.[1];
  const message = tagText(xml, 'Message') ?? tagText(xml, 'Text') ?? 'WinRM fault';
  return { code, message: message.replace(/<[^>]+>/g, '').trim() };
}

/** WinRM fault code returned when Receive has no output before OperationTimeout; it is not an error. */
export const RECEIVE_TIMEOUT_FAULT = '2150858793';
