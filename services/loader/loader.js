// Loader logic (pure): batch file text -> one raw row per message.
// Row shape matches the manual run's raw.messages table.
import { splitMessages, messageHash } from '@pipeline/hl7';

export const RAW_SCHEMA = 'msg_no:INTEGER,file_name:STRING,message:STRING,message_hash:STRING,loaded_at:TIMESTAMP';

export function toRawRows({ fileName, text, loadedAt = new Date() }) {
  return splitMessages(text).map((message, i) => ({
    msg_no: i + 1,
    file_name: fileName,
    message, // unchanged apart from \r between segments; no parsing (ELT)
    message_hash: messageHash(message),
    loaded_at: loadedAt.toISOString(),
  }));
}

export const toNdjson = (rows) => rows.map((r) => JSON.stringify(r)).join('\n') + '\n';
