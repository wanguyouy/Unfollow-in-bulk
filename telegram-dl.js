/* ============================================================
 * Telegram 媒体下载（跑在本机已登录的 MTProto 会话上）
 * ------------------------------------------------------------
 * 依赖 telegram-mtproto.js（传输/加密）与 telegram-session.js（提取 tdata 授权）。
 *
 * 流程：t.me/<channel>/<id>
 *   1) contacts.resolveUsername → InputChannel(id + access_hash)
 *   2) channels.getMessages    → message 里的 media(document/photo)
 *   3) upload.getFile 分块下载（1MB/块）；文件不在当前 DC 时
 *      服务器回 FILE_MIGRATE_N → auth.export/import 授权到目标 DC 再下。
 *
 * TL 解析用「字段模式表」（layer 233 schema，抄自 tdesktop api.tl）：
 *   i=int l=long s=string b=bytes d=double v=vector<obj> vi=vector<int> vn=vector(obj,非严格)
 *   f:N = word0 bit N 才出现；f2:N = word1(bit N)。
 * 有 flags 词的对象必须登记进 HAS_FLAGS。
 * 未知构造号会抛错（带 tag），遇到就补表 —— 宁可失败也不乱猜字节。
 * ============================================================ */
const zlib = require('zlib');
const fs = require('fs');
const M = require('./telegram-mtproto');
const tf = require('./telegram-fetch');
const tgs = require('./telegram-session');

/* ---------- 构造号（layer 233） ---------- */
const C = {
  resolvedPeer: 0x7f077ad9,
  peerUser: 0x59511722,
  peerChannel: 0xa2a5371e,
  messagesMessages: 0x1d73e7ea,
  messagesChannelMessages: 0xc776ba4e,
  messagesNotModified: 0x74535f21,
  chatEmpty: 0x29562865,
  chat: 0x41cbf256,
  channel: 0x7ad15240,
  channelForbidden: 0x17d493d5,
  user: 0xb1b8cc83,
  userPhotoEmpty: 0x4f11bae0,
  userPhoto: 0xe9bfddcf,
  userProfilePhoto: 0x82d1f706,
  message: 0x7600b9d3,
  messageEmpty: 0x90a6ca84,
  messageService: 0x7a800e0a,
  mediaPhoto: 0xe216eb63,
  mediaDocument: 0x52d8ccd9,
  mediaUnsupported: 0x9a3fca96,
  document: 0x8fd4c4d8,
  documentEmpty: 0x36f8c871,
  photo: 0xfb197a65,
  photoEmpty: 0x2331b22d,
  photoSizeEmpty: 0xe17e23c0,
  photoSize: 0x75c78e60,
  photoStrippedSize: 0xe0b0bc2e,
  photoSizeProgressive: 0xfa3efb95,
  photoPathSize: 0xd8214d41,
  videoSize: 0xde33b094,
  videoSizeEmojiMarkup: 0xf85c413c,
  videoSizeStickerMarkup: 0xda082fe,
  attrImageSize: 0x6c37c15c,
  attrAnimated: 0x11b58939,
  attrSticker: 0x6319d612,
  attrVideo: 0x43c57c48,
  attrAudio: 0x9852f9c6,
  attrFilename: 0x15590068,
  attrHasStickers: 0x9801d2f7,
  attrCustomEmoji: 0xfd149899,
  maskCoords: 0xaed6dbb2,
  fwdHeader: 0x4e4df4bb,
  replyHeader: 0xddb5ab75,
  replies: 0x83d60fc2,
  reactions: 0xa339f0b,
  reactionCount: 0xa3d1cb80,
  reactionEmpty: 0x79f5d419,
  reactionEmoji: 0x1b2286b8,
  reactionCustomEmoji: 0x8935fc73,
  reactionPaid: 0x523da4eb,
  peerReaction: 0x8c79b63c,
  reactor: 0x4ba3a95a,
  replyKeyboardHide: 0xa03e5b85,
  replyKeyboardForceReply: 0x86b40b08,
  replyKeyboardMarkup: 0x85dd99d1,
  replyInlineMarkup: 0xb2b15770,
  keyboardButtonRow: 0x77608b83,
  keyboardButton: 0x2f67a72f,
  keyboardInlineButtonRow: 0x19420af6,
  keyboardInlineButton: 0x11c1a322,
  keyboardButtonStyle: 0x4fdd3430,
  restrictionReason: 0xd072acb4,
  username: 0xb4073647,
  peerColor: 0xb54b5acf,
  peerColorCollectible: 0xb9c0639a,
  emojiStatusEmpty: 0x2de11aae,
  emojiStatus: 0xe7ff068a,
  emojiStatusCollectible: 0x7184603b,
  recentStory: 0x711d692d,
  chatPhotoEmpty: 0x37c1011c,
  chatPhoto: 0x1c6e1c11,
  chatBannedRights: 0x9f120418,
  peerChannel: 0xa2a5371e,
  uploadFile: 0x96a18d5,
  uploadFileCdnRedirect: 0xf18cda44,
  storageFileJpeg: 0x7efe0e,
  storageFileUnknown: 0xaa963b05,
  storageFilePartial: 0x40bc6f52,
  storageFilePng: 0xa4f63c0,
  storageFilePdf: 0xae1e508d,
  storageFileMov: 0x4b09ebbc,
  storageFileMp4: 0xb3cea0e4,
  storageFileWebp: 0x1081464c,
  storageFileGif: 0xcae1aadf,
  entity: new Set([
    0xbb92ba95, 0xfa04579d, 0x6f635b0d, 0x6cef8ac7, 0x6ed02538, 0x64e475c2,
    0xbd610bc9, 0x826f8b60, 0x28a20571, 0x73924be0, 0x76a6d327, 0xdc7b1140,
    0x9b69e34b, 0x4c4e743f, 0x9c4e7e8b, 0xbf0693d4, 0x761e6af4, 0x32ca960f,
    0xc8cf05f8, 0xf1ccaaac, 0x904ac7c7, 0x71777116, 0xc6c1e5a7, 0x652c1c5,
  ]),
};

/* ---------- 字段模式表 ---------- */
/* i=int l=long s=string b=bytes d=double v=vector<obj> vi=vector<int>
   f:N = word0 bit N 才有；f2:N = word1 bit N 才有 */
const S = new Map();
const HAS_FLAGS = new Set();
const HAS_FLAGS2 = new Set();
function def(tag, fields, hasFlags) {
  S.set(tag, fields);
  if (hasFlags) HAS_FLAGS.add(tag);
  if (hasFlags && fields.some((f) => f.f && f.f.startsWith('f2:'))) HAS_FLAGS2.add(tag);
}
const F = (n, t, f) => ({ n, t, f });

/* contacts.ResolvedPeer / Peer */
def(C.resolvedPeer, [F('peer', 'o'), F('chats', 'vn'), F('users', 'vn')]);
def(C.peerUser, [F('user_id', 'l')]);
def(C.peerChannel, [F('channel_id', 'l')]);

/* messages.Messages */
/* messages/topics/chats/users 走非严格向量（'vn'）：只有 document/photo 媒体可下载
 * （schema 完整必能解析），webpage/投票/礼物等不可下载媒体（webPage 又牵
 * Page/RichText 巨族）解析失败时只丢弃该条消息 —— 单帖链接下等价于「无媒体」，
 * 其余消息与整体请求不受影响 */
def(C.messagesMessages, [F('messages', 'vn'), F('topics', 'vn'), F('chats', 'vn'), F('users', 'vn')]);
def(C.messagesChannelMessages, [
  F('pts', 'i'), F('count', 'i'), F('offset_id_offset', 'i', 'f:2'),
  F('messages', 'vn'), F('topics', 'vn'), F('chats', 'vn'), F('users', 'vn'),
], true);
def(C.messagesNotModified, [F('count', 'i')]);

/* Chat 家族 */
def(C.chatEmpty, [F('id', 'l')]);
def(C.chat, [
  F('id', 'l'), F('title', 's'), F('photo', 'o'), F('participants_count', 'i'),
  F('date', 'i'), F('version', 'i'),
  F('migrated_to', 'o', 'f:6'), F('admin_rights', 'o', 'f:14'), F('default_banned_rights', 'o', 'f:18'),
], true);
def(C.channel, [
  F('id', 'l'), F('access_hash', 'l', 'f:13'), F('title', 's'), F('username', 's', 'f:6'),
  F('photo', 'o'), F('date', 'i'),
  F('restriction_reason', 'v', 'f:9'), F('admin_rights', 'o', 'f:14'),
  F('banned_rights', 'o', 'f:15'), F('default_banned_rights', 'o', 'f:18'),
  F('participants_count', 'i', 'f:17'), F('usernames', 'v', 'f2:0'),
  F('stories_max_id', 'o', 'f2:4'), F('color', 'o', 'f2:7'), F('profile_color', 'o', 'f2:8'),
  F('emoji_status', 'o', 'f2:9'), F('level', 'i', 'f2:10'), F('subscription_until_date', 'i', 'f2:11'),
  F('bot_verification_icon', 'l', 'f2:13'), F('send_paid_messages_stars', 'i', 'f2:14'),
  F('linked_monoforum_id', 'l', 'f2:18'), F('linked_community_id', 'l', 'f2:20'),
  F('pinned_msg_id', 'i', 'f2:22'),
], true);
def(C.channelForbidden, [
  F('id', 'l'), F('access_hash', 'l'), F('title', 's'), F('until_date', 'i', 'f:16'),
], true);

/* User 家族（只为跳过/轻量取值） */
def(C.  userPhotoEmpty, []);
def(C.userPhoto, [F('photo_id', 'l'), F('stripped_thumb', 'b', 'f:1'), F('dc_id', 'i')], true);
def(C.userProfilePhoto, [F('photo_id', 'l'), F('stripped_thumb', 'b', 'f:1'), F('dc_id', 'i')], true);
def(C.user, [
  F('id', 'l'), F('access_hash', 'l', 'f:0'), F('first_name', 's', 'f:1'), F('last_name', 's', 'f:2'),
  F('username', 's', 'f:3'), F('phone', 's', 'f:4'), F('photo', 'o', 'f:5'), F('status', 'o', 'f:6'),
  F('bot_info_version', 'i', 'f:14'), F('restriction_reason', 'v', 'f:18'),
  F('bot_inline_placeholder', 's', 'f:19'), F('lang_code', 's', 'f:22'),
  F('emoji_status', 'o', 'f:30'), F('usernames', 'v', 'f2:0'), F('stories_max_id', 'o', 'f2:5'),
  F('color', 'o', 'f2:8'), F('profile_color', 'o', 'f2:9'),
  F('bot_active_users', 'i', 'f2:12'), F('bot_verification_icon', 'l', 'f2:14'),
  F('send_paid_messages_stars', 'i', 'f2:15'), F('linked_community_id', 'l', 'f2:21'),
], true);

/* Message 家族 */
def(C.messageEmpty, [F('id', 'i'), F('peer_id', 'o', 'f:0')], true);
def(C.message, [
  F('id', 'i'),
  F('from_id', 'o', 'f:8'), F('from_boosts_applied', 'i', 'f:29'),
  F('from_rank', 's', 'f2:12'),
  F('peer_id', 'o'), F('saved_peer_id', 'o', 'f:28'),
  F('fwd_from', 'o', 'f:2'), F('via_bot_id', 'l', 'f:11'), F('via_business_bot_id', 'l', 'f2:0'),
  F('guestchat_via_from', 'o', 'f2:19'),
  F('reply_to', 'o', 'f:3'),
  F('date', 'i'), F('message', 's'),
  F('media', 'o', 'f:9'), F('reply_markup', 'o', 'f:6'), F('entities', 'v', 'f:7'),
  F('views', 'i', 'f:10'), F('forwards', 'i', 'f:10'),
  F('replies', 'o', 'f:23'), F('edit_date', 'i', 'f:15'), F('post_author', 's', 'f:16'),
  F('grouped_id', 'l', 'f:17'), F('reactions', 'o', 'f:20'),
  F('restriction_reason', 'v', 'f:22'), F('ttl_period', 'i', 'f:25'),
  F('quick_reply_shortcut_id', 'i', 'f:30'), F('effect', 'l', 'f2:2'),
  F('factcheck', 'o', 'f2:3'), F('report_delivery_until_date', 'i', 'f2:5'),
  F('paid_message_stars', 'l', 'f2:6'), F('suggested_post', 'o', 'f2:7'),
  F('schedule_repeat_period', 'i', 'f2:10'), F('summary_from_language', 's', 'f2:11'),
  F('rich_message', 'o', 'f2:13'),
], true);
def(C.messageService, [
  F('id', 'i'), F('from_id', 'o', 'f:8'), F('peer_id', 'o'), F('saved_peer_id', 'o', 'f:28'),
  F('reply_to', 'o', 'f:3'), F('date', 'i'), F('action', 'o'), F('reactions', 'o', 'f:20'),
  F('ttl_period', 'i', 'f:25'),
], true);

/* media / document / photo */
def(C.mediaPhoto, [F('photo', 'o', 'f:0'), F('ttl_seconds', 'i', 'f:2')], true);
def(C.mediaDocument, [
  F('document', 'o', 'f:0'),
  F('alt_documents', 'v', 'f:5'),
  F('video_cover', 'o', 'f:9'), F('video_timestamp', 'i', 'f:10'),
  F('ttl_seconds', 'i', 'f:2'),
], true);
def(C.mediaUnsupported, []);
def(C.document, [
  F('id', 'l'), F('access_hash', 'l'), F('file_reference', 'b'), F('date', 'i'),
  F('mime_type', 's'), F('size', 'l'),
  F('thumbs', 'v', 'f:0'), F('video_thumbs', 'v', 'f:1'),
  F('dc_id', 'i'), F('attributes', 'v'),
], true);
def(C.documentEmpty, [F('id', 'l')]);
def(C.photo, [
  F('id', 'l'), F('access_hash', 'l'), F('file_reference', 'b'), F('date', 'i'),
  F('sizes', 'v'), F('video_sizes', 'v', 'f:1'), F('dc_id', 'i'),
], true);
def(C.photoEmpty, [F('id', 'l')]);

/* PhotoSize / VideoSize */
def(C.photoSizeEmpty, [F('type', 's')]);
def(C.photoSize, [F('type', 's'), F('w', 'i'), F('h', 'i'), F('size', 'i')]);
def(C.photoStrippedSize, [F('type', 's'), F('bytes', 'b')]);
def(C.photoSizeProgressive, [F('type', 's'), F('w', 'i'), F('h', 'i'), F('sizes', 'vi')]);
def(C.photoPathSize, [F('type', 's'), F('bytes', 'b')]);
def(C.videoSize, [F('type', 's'), F('w', 'i'), F('h', 'i'), F('size', 'i'), F('video_start_ts', 'd', 'f:0')], true);
def(C.videoSizeEmojiMarkup, [F('emoji_id', 'l'), F('background_colors', 'vi')]);
def(C.videoSizeStickerMarkup, [F('stickerset', 'o'), F('sticker_id', 'l'), F('background_colors', 'vi')]);

/* attributes */
def(C.attrImageSize, [F('w', 'i'), F('h', 'i')]);
def(C.attrAnimated, []);
def(C.attrHasStickers, []);
def(C.attrSticker, [F('alt', 's'), F('stickerset', 'o'), F('mask_coords', 'o', 'f:0')], true);
def(C.attrVideo, [
  F('duration', 'd'), F('w', 'i'), F('h', 'i'),
  F('preload_prefix_size', 'i', 'f:2'), F('video_start_ts', 'd', 'f:4'), F('video_codec', 's', 'f:5'),
], true);
def(C.attrAudio, [
  F('duration', 'i'), F('title', 's', 'f:0'), F('performer', 's', 'f:1'), F('waveform', 'b', 'f:2'),
], true);
def(C.attrFilename, [F('file_name', 's')]);
def(C.attrCustomEmoji, [F('alt', 's'), F('stickerset', 'o')], true);
def(C.maskCoords, [F('n', 'i'), F('x', 'd'), F('y', 'd'), F('zoom', 'd')]);

/* 杂项跳过对象 */
def(C.fwdHeader, [
  F('from_id', 'o', 'f:0'), F('from_name', 's', 'f:5'), F('date', 'i'),
  F('channel_post', 'i', 'f:2'), F('post_author', 's', 'f:3'),
  F('saved_from_peer', 'o', 'f:4'), F('saved_from_msg_id', 'i', 'f:4'),
  F('saved_from_id', 'o', 'f:8'), F('saved_from_name', 's', 'f:9'), F('saved_date', 'i', 'f:10'),
  F('psa_type', 's', 'f:6'),
], true);
def(C.replyHeader, [
  F('reply_to_msg_id', 'i', 'f:4'), F('reply_to_peer_id', 'o', 'f:0'),
  F('reply_from', 'o', 'f:5'), F('reply_media', 'o', 'f:8'),
  F('reply_to_top_id', 'i', 'f:1'), F('quote_text', 's', 'f:6'),
  F('quote_entities', 'v', 'f:7'), F('quote_offset', 'i', 'f:10'),
  F('todo_item_id', 'i', 'f:11'), F('poll_option', 'b', 'f:12'),
], true);
def(C.replies, [
  F('replies', 'i'), F('replies_pts', 'i'),
  F('recent_repliers', 'v', 'f:1'), F('channel_id', 'l', 'f:0'),
  F('max_id', 'i', 'f:2'), F('read_max_id', 'i', 'f:3'),
], true);
def(C.reactions, [
  F('results', 'v'), F('recent_reactions', 'v', 'f:1'), F('top_reactors', 'v', 'f:4'),
], true);
def(C.reactionCount, [F('chosen_order', 'i', 'f:0'), F('reaction', 'o'), F('count', 'i')], true);
def(C.reactionEmpty, []);
def(C.reactionEmoji, [F('emoticon', 's')]);
def(C.reactionCustomEmoji, [F('document_id', 'l')]);
def(C.reactionPaid, []);
def(C.peerReaction, [F('peer_id', 'o'), F('date', 'i'), F('reaction', 'o')], true);
def(C.reactor, [F('peer_id', 'o', 'f:3'), F('count', 'i')], true);
def(C.replyKeyboardHide, [], true);
def(C.replyKeyboardForceReply, [F('placeholder', 's', 'f:3')], true);
def(C.replyKeyboardMarkup, [F('rows', 'v'), F('placeholder', 's', 'f:3')], true);
def(C.replyInlineMarkup, [F('rows', 'v')], true);
def(C.keyboardButtonRow, [F('buttons', 'v')]);
def(C.keyboardInlineButtonRow, [F('buttons', 'v')]);
def(C.keyboardButton, [F('style', 'o', 'f:10'), F('text', 's'), F('type', 'o')], true);
def(C.keyboardInlineButton, [F('style', 'o', 'f:10'), F('text', 's'), F('type', 'o')], true);
def(C.keyboardButtonStyle, [F('icon', 'l', 'f:3')], true);
def(C.restrictionReason, [F('platform', 's'), F('reason', 's'), F('text', 's')]);
def(C.username, [F('username', 's')], true);
def(C.peerColor, [F('color', 'i', 'f:0'), F('background_emoji_id', 'l', 'f:1')], true);
def(C.peerColorCollectible, [
  F('collectible_id', 'l'), F('gift_emoji_id', 'l'), F('background_emoji_id', 'l'),
  F('accent_color', 'i'), F('colors', 'vi'),
  F('dark_accent_color', 'i', 'f:0'), F('dark_colors', 'vi', 'f:1'),
], true);
def(C.emojiStatusEmpty, []);
def(C.emojiStatus, [F('document_id', 'l'), F('until', 'i', 'f:0')], true);
def(C.emojiStatusCollectible, [
  F('collectible_id', 'l'), F('document_id', 'l'), F('title', 's'), F('slug', 's'),
  F('pattern_document_id', 'l'), F('center_color', 'i'), F('edge_color', 'i'),
  F('pattern_color', 'i'), F('text_color', 'i'), F('until', 'i', 'f:0'),
], true);
def(C.recentStory, [F('max_id', 'i', 'f:1')], true);
def(C.chatPhotoEmpty, []);
def(C.chatPhoto, [F('photo_id', 'l'), F('stripped_thumb', 'b', 'f:1'), F('dc_id', 'i')], true);
/* chatBannedRights：flags.0..27 全是 true 标记（序列化为零字节），实际数据只有末尾的 until_date */
def(C.chatBannedRights, [F('until_date', 'i')], true);
def(C.messagesNotModified, [F('count', 'i')]);
/* upload.File / storage.FileType */
def(C.uploadFile, [F('type', 'o'), F('mtime', 'i'), F('bytes', 'b')]);
def(C.uploadFileCdnRedirect, [
  F('dc_id', 'i'), F('file_token', 'b'), F('encryption_key', 'b'),
  F('encryption_iv', 'b'), F('file_hashes', 'v'),
]);
for (const st of [C.storageFileJpeg, C.storageFileUnknown, C.storageFilePartial, C.storageFilePng, C.storageFilePdf, C.storageFileMov, C.storageFileMp4, C.storageFileWebp, C.storageFileGif]) def(st, []);

/* ---------- TL 字节游标 ---------- */
class Cur {
  constructor(buf) { this.b = buf; this.o = 0; }
  int() { const v = this.b.readInt32LE(this.o); this.o += 4; return v; }
  uint() { const v = this.b.readUInt32LE(this.o); this.o += 4; return v; }
  long() { const v = this.b.readBigInt64LE(this.o); this.o += 8; return v; }
  dbl() { const v = this.b.readDoubleLE(this.o); this.o += 8; return v; }
  bytes() {
    const first = this.b.readUInt8(this.o);
    let len; let head;
    if (first === 254) { len = this.b.readUIntLE(this.o + 1, 3); head = 4; }
    else { len = first; head = 1; }
    const start = this.o + head;
    const out = Buffer.from(this.b.subarray(start, start + len));
    this.o = start + len + ((4 - ((head + len) % 4)) % 4);
    return out;
  }
  str() { return this.bytes().toString('utf8'); }
}

/* 读一个对象；ctx.flags = [word0, word1]（父对象上下文） */
function readObj(cur, tag, keepFlags) {
  const fields = S.get(tag);
  if (fields === undefined) {
    if (C.entity.has(tag)) {
      const e = { tag, offset: cur.int(), length: cur.int() };
      if (tag === 0x73924be0) e.language = cur.str();
      else if (tag === 0x76a6d327) e.url = cur.str();
      else if (tag === 0xdc7b1140) e.user_id = cur.long().toString();
      else if (tag === 0xc8cf05f8) e.document_id = cur.long().toString();
      else if (tag === 0x904ac7c7) e.date = cur.int();
      else if (tag === 0xc6c1e5a7) e.old_text = cur.str();
      return e;
    }
    if (tag === C.reactionEmpty || tag === C.reactionPaid) return { tag };
    throw new Error('未知 TL 构造 0x' + tag.toString(16) + '（需要补 schema）');
  }
  const out = { tag };
  if (HAS_FLAGS.has(tag)) {
    out._flags = [cur.int()];
    if (HAS_FLAGS2.has(tag)) out._flags.push(cur.int());
    const has = (spec) => {
      const [g, bit] = spec.startsWith('f2:') ? [1, Number(spec.slice(3))] : [0, Number(spec.slice(2))];
      return Boolean(out._flags[g] & (1 << bit));
    };
    for (const f of fields) {
      if (f.f && !has(f.f)) continue;
      readField(cur, f, out, tag);
    }
    return out;
  }
  for (const f of fields) readField(cur, f, out, tag);
  return out;
}

function readField(cur, f, out, parentTag) {
  const put = (v) => { if (f.n) out[f.n] = v; };
  switch (f.t) {
    case 'i': put(cur.int()); break;
    case 'l': put(cur.long().toString()); break;
    case 'd': put(cur.dbl()); break;
    case 's': put(cur.str()); break;
    case 'b': put(cur.bytes().toString('hex')); break;
    case 'o': { const t = cur.uint(); put(readObj(cur, t)); break; }
    case 'v': {
      const vt = cur.uint();
      const count = cur.int();
      if (vt !== 0x1cb5c415) throw new Error('期望 vector tag 得到 0x' + vt.toString(16) + ' @父对象 0x' + parentTag.toString(16) + ' 字段 ' + f.n + ' @offset ' + (cur.o - 8) + ' 上下文hex ' + cur.b.subarray(Math.max(0, cur.o - 40), cur.o + 16).toString('hex'));
      const arr = [];
      for (let i = 0; i < count; i += 1) { const t = cur.uint(); arr.push(readObj(cur, t)); }
      put(arr);
      break;
    }
    case 'vi': {
      const vt = cur.uint();
      const count = cur.int();
      if (vt !== 0x1cb5c415) throw new Error('期望 vector tag 得到 0x' + vt.toString(16));
      const arr = [];
      for (let i = 0; i < count; i += 1) arr.push(cur.int());
      put(arr);
      break;
    }
    /* 非严格向量：逐元素解析，单个失败即放弃整个向量（不抛出）。
     * 只用于业务上不需要、且含大量可选字段的 chats/users —— 它们都是容器的最后
     * 一个字段，中途停下的错位不会影响任何后续字段。 */
    case 'vn': {
      const vt = cur.uint();
      const count = cur.int();
      if (vt !== 0x1cb5c415) return;
      const arr = [];
      for (let i = 0; i < count; i += 1) {
        try {
          const t = cur.uint();
          arr.push(readObj(cur, t));
        } catch (e) {
          out._partial = (out._partial || []).concat(f.n);
          break;
        }
      }
      put(arr);
      break;
    }
    default: throw new Error('坏字段类型 ' + f.t + ' @0x' + parentTag.toString(16));
  }
}

/* ---------- 会话管理 ---------- */
const dcCache = new Map(); // dcId -> MtpSession

function getSession(ses, dcId, proxy) {
  const k = ses.keys.find((x) => x.dcId === dcId);
  if (!k) throw new Error('tdata 里没有 DC' + dcId + ' 的授权密钥');
  return new M.MtpSession({ authKey: k.key, dcId, proxy });
}

async function ensureConnected(c) {
  if (c.socket) return;
  await c.connect(15000);
}

/* rpc：send 返回的就是 rpc_result 的 result 部分；处理 gzip 与 rpc_error */
async function rpcWrap(c, body) {
  let r = await c.send(body);
  if (r.length >= 4 && r.readUInt32LE(0) === 0x3072cfa1) {
    const rd = new M.Reader(r);
    rd.uint();
    r = zlib.gunzipSync(rd.bytes());
  }
  const t = r.readUInt32LE(0);
  if (t === 0x2144ca19) {
    const rd = new M.Reader(r);
    rd.uint();
    const code = rd.int();
    const msg = rd.string();
    const e = new Error('rpc_error ' + code + ' ' + msg);
    e.rpc = { code, msg };
    throw e;
  }
  return r;
}

/* 所有业务 RPC 都套 invokeWithLayer+initConnection（tdesktop 同款做法） */
function wrapQuery(body) {
  return M.TL.invokeWithLayer(M.TL.initConnection(body));
}

/* 跨 DC：export → import → 新会话 */
async function migrate(ses, dcId, proxy) {
  if (dcCache.has(dcId)) return dcCache.get(dcId);
  const main = dcCache.get(ses.mainDcId || 2) || getSession(ses, ses.mainDcId || 2, proxy);
  dcCache.set(ses.mainDcId || 2, main);
  await ensureConnected(main);
  const r = await rpcWrap(main, Buffer.concat([M.tlUInt(0xe5bfffcd), M.tlInt(dcId)]));
  const cur = new Cur(r);
  const exported = readObj(cur, cur.uint());
  const target = getSession(ses, dcId, proxy);
  await target.connect(15000);
  await rpcWrap(target, Buffer.concat([
    M.tlUInt(0xa57a7dad),
    M.tlLong(BigInt(exported.id)),
    M.tlBytes(Buffer.from(exported.bytes, 'hex')),
  ]));
  dcCache.set(dcId, target);
  return target;
}

/* 处理 FILE_MIGRATE 错误：返回（可能切换后的）会话 */
async function handleMigrate(ses, err, proxy, cacheKey) {
  const mig = /(?:FILE|NETWORK|PHONE)_MIGRATE_(\d+)/.exec(String((err && err.message) || ''));
  if (!mig) throw err;
  return migrate(ses, Number(mig[1]), proxy);
}

/* ---------- 高层 API ---------- */

/* 解析 t.me/<ch>/<id> */
function parseLink(text) {
  const s = String(text || '').trim();
  const m = s.match(/t\.me\/([A-Za-z0-9_]+)(?:\/(\d+))?/) || s.match(/^@([A-Za-z0-9_]+)/);
  if (!m) return null;
  return { username: m[1], msgId: m[2] ? Number(m[2]) : null };
}

/* 拿帖子的媒体元数据 */
async function fetchPost(opts) {
  const ses = tgs.readSession();
  if (!ses || !ses.ok) throw new Error((ses && ses.message) || '读不到 tdata 会话');
  const proxy = opts.proxy === undefined ? tf.resolveProxy({}) : opts.proxy;
  const link = parseLink(opts.link);
  if (!link) throw new Error('链接格式不认识');

  let c = dcCache.get(ses.mainDcId || 2) || getSession(ses, ses.mainDcId || 2, proxy);
  dcCache.set(ses.mainDcId || 2, c);
  await ensureConnected(c);

  /* 1) resolveUsername */
  let resolved;
  try {
    resolved = await rpcWrap(c, wrapQuery(Buffer.concat([
      M.tlUInt(0x725afbbc), M.tlInt(0), M.tlString(link.username),
    ])));
  } catch (e) {
    if ((e.rpc && e.rpc.code === 303) || /MIGRATE_/.test(e.message)) {
      c = await handleMigrate(ses, e, proxy);
      resolved = await rpcWrap(c, wrapQuery(Buffer.concat([
        M.tlUInt(0x725afbbc), M.tlInt(0), M.tlString(link.username),
      ])));
    } else throw e;
  }
  const cur = new Cur(resolved);
  const r1 = readObj(cur, cur.uint());
  let channel = null;
  if (r1.peer && r1.peer.tag === C.peerChannel) {
    const chats = r1.chats || [];
    channel = chats.find((ch) => ch && (ch.tag === C.channel || ch.tag === C.channelForbidden)
      && String(ch.id) === String(r1.peer.channel_id)) || null;
    if (!channel) channel = chats.find((ch) => ch && ch.tag === C.channel) || null;
  }
  if (!channel || channel.access_hash === undefined) {
    throw new Error('频道解析失败：用户名不存在，或该账号不在频道内');
  }

  /* 2) getMessages */
  if (!link.msgId) throw new Error('链接里没有帖子 ID');
  const ids = Array.isArray(opts.msgIds) && opts.msgIds.length ? opts.msgIds : [link.msgId];
  const getMsgs = () => Buffer.concat([
    M.tlUInt(0xad8c9a23),
    M.tlUInt(0xf35aec28), M.tlLong(BigInt(channel.id)), M.tlLong(BigInt(channel.access_hash)),
    M.tlInt(0x1cb5c415), M.tlInt(ids.length),
    ...ids.map((id) => Buffer.concat([M.tlUInt(0xa676a322), M.tlInt(id)])),
  ]);
  let msgsResp;
  try {
    msgsResp = await rpcWrap(c, wrapQuery(getMsgs()));
  } catch (e) {
    if ((e.rpc && e.rpc.code === 303) || /MIGRATE_/.test(e.message)) {
      c = await handleMigrate(ses, e, proxy);
      msgsResp = await rpcWrap(c, wrapQuery(getMsgs()));
    } else throw e;
  }
  const cur2 = new Cur(msgsResp);
  const resp = readObj(cur2, cur2.uint());
  const msgs = (resp && resp.messages) || [];
  const items = [];
  for (const msg of msgs) {
    if (msg === null || msg.tag !== C.message) continue;
    const m = extractMedia(msg);
    if (m) items.push(m);
  }
  return {
    channel: { id: channel.id, title: channel.title || '', username: channel.username || '' },
    items,
  };
}

/* 从 message 提取媒体元数据 */
function extractMedia(msg) {
  const media = msg.media;
  if (!media) return null;
  if (media.tag === C.mediaDocument && media.document && media.document.tag === C.document) {
    const doc = media.document;
    let filename = '';
    let isVideo = false;
    let isVoice = false;
    let isSticker = false;
    let isAnimated = false;
    for (const a of doc.attributes || []) {
      if (!a) continue;
      if (a.tag === C.attrFilename) filename = a.file_name;
      if (a.tag === C.attrVideo) isVideo = true;
      if (a.tag === C.attrAudio && a._flags && (a._flags[0] & 1)) isVoice = true;
      if (a.tag === C.attrSticker) isSticker = true;
      if (a.tag === C.attrAnimated) isAnimated = true;
    }
    return {
      kind: 'document',
      dcId: doc.dc_id,
      docId: doc.id,
      accessHash: doc.access_hash,
      fileReference: doc.file_reference,
      size: Number(doc.size),
      mime: doc.mime_type,
      filename: filename || '',
      isVideo, isVoice, isSticker, isAnimated,
      msgId: msg.id,
      text: msg.message || '',
    };
  }
  if (media.tag === C.mediaPhoto && media.photo && media.photo.tag === C.photo) {
    const ph = media.photo;
    let best = null;
    for (const ps of ph.sizes || []) {
      if (!ps) continue;
      if (ps.tag === C.photoSize || ps.tag === C.photoSizeProgressive) {
        if (!best || (ps.w * ps.h) > (best.w * best.h)) best = ps;
      }
    }
    return {
      kind: 'photo',
      dcId: ph.dc_id,
      docId: ph.id,
      accessHash: ph.access_hash,
      fileReference: ph.file_reference,
      size: best ? best.size : 0,
      bestType: best ? best.type : '',
      msgId: msg.id,
      text: msg.message || '',
    };
  }
  return null;
}

/* 下载一个媒体。带 opts.dest 时分块直写磁盘（大文件不攒内存），
 * 返回 { bytes }；否则攒 Buffer 返回（小文件兼容旧用法）。 */
async function downloadMedia(opts) {
  const ses = tgs.readSession();
  if (!ses || !ses.ok) throw new Error('读不到 tdata 会话');
  const proxy = opts.proxy === undefined ? tf.resolveProxy({}) : opts.proxy;
  const media = opts.media;
  if (!media) throw new Error('缺 media');
  const stream = opts.dest ? fs.createWriteStream(opts.dest) : null;
  let streamErr = null;
  if (stream) stream.on('error', (e) => { streamErr = e; });

  let c = dcCache.get(media.dcId) || getSession(ses, media.dcId, proxy);
  dcCache.set(media.dcId, c);
  await ensureConnected(c);

  const location = media.kind === 'document'
    ? Buffer.concat([
      M.tlUInt(0xbad07584),
      M.tlLong(BigInt(media.docId)), M.tlLong(BigInt(media.accessHash)),
      M.tlBytes(Buffer.from(media.fileReference, 'hex')), M.tlString(''),
    ])
    : Buffer.concat([
      M.tlUInt(0x40181ffe),
      M.tlLong(BigInt(media.docId)), M.tlLong(BigInt(media.accessHash)),
      M.tlBytes(Buffer.from(media.fileReference, 'hex')), M.tlString(media.bestType || 'x'),
    ]);
  const CH = 1048576;
  const parts = [];
  let offset = 0;
  for (;;) {
    let chunkResp;
    try {
      chunkResp = await rpcWrap(c, wrapQuery(Buffer.concat([
        M.tlUInt(0xbe5335be), M.tlInt(0),
        location, M.tlLong(BigInt(offset)), M.tlInt(CH),
      ])));
    } catch (e) {
      if ((e.rpc && e.rpc.code === 303) || /MIGRATE_/.test(e.message)) {
        c = await handleMigrate(ses, e, proxy, media.dcId);
        await ensureConnected(c);
        continue;
      }
      throw e;
    }
    const cur = new Cur(chunkResp);
    const resp = readObj(cur, cur.uint());
    if (resp.tag === C.uploadFileCdnRedirect) throw new Error('CDN 重定向暂不支持');
    if (resp.tag !== C.uploadFile) throw new Error('意外的 getFile 响应 0x' + resp.tag.toString(16));
    const data = Buffer.from(resp.bytes, 'hex');
    if (!data.length) break;
    if (stream) {
      if (!stream.write(data)) {
        await new Promise((res) => stream.once('drain', res));
      }
      if (streamErr) throw streamErr;
    } else {
      parts.push(data);
    }
    offset += data.length;
    if (typeof opts.onProgress === 'function') {
      try { opts.onProgress({ received: offset, total: media.size || 0 }); } catch (e) { /* ignore */ }
    }
    if (data.length < CH) break;
    if (media.size && offset >= media.size) break;
    if (!stream && parts.length > 4096) throw new Error('下载异常过长，已中止');
  }
  if (stream) {
    await new Promise((res) => stream.end(res));
    if (streamErr) throw streamErr;
    return { bytes: offset };
  }
  return Buffer.concat(parts);
}

module.exports = { parseLink, fetchPost, downloadMedia, extractMedia, C, S, Cur, readObj };
