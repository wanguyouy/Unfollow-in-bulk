# B 站助手(Bilibili Unfollow Helper)

Electron 桌面小工具:批量清理 Bilibili 关注列表 + 六平台内容下载(B 站 / 抖音 / 公众号 / 支付宝 / Telegram / 微信视频号)
\+ Telegram 本地缓存离线恢复(私密频道也能取)+ Telegram 私密频道 MTProto 解析(复用本机已登录会话)。

> 仅操作你自己账号的数据,仅供学习交流,请勿用于任何违规用途。

## 功能

### ① B 站批量取关
- 应用内登录 B 站(扫码/账密,凭证只保存在本机 Electron 会话)
- 一键读取全部关注列表(最多 2000)
- 保留名单:按昵称关键词或 UID 跳过不想取关的账号
- 执行前显示数量与名单示例,输入数字二次确认
- 逐个取关 + 进度条 + 实时日志,可随时停止
- 风控保护:遇 -352/-412 自动等待 8 秒重试,连续 3 次自动暂停;失败名单一键重试

### ② B 站视频下载
- 粘贴分享链接(b23.tv 短链)/ BV 号 / av 号
- 分 P 选择 + 清晰度选择(DASH)
- 自动下载视频/音频流并用 ffmpeg 合并为 MP4

### ③ 抖音视频 / 图集下载
- 粘贴分享链接(v.douyin.com 短链)、视频/图文链接或作品 ID
- 内嵌窗口捕获作品详情:视频取最高码率 `play_addr` 下载无水印 MP4;
  图集取 `images[]`,按 01.jpg / 02.jpg… 存进以标题命名的子目录(优先 `download_url_list` 无水印原图)
- 公开作品无需登录;分不清是视频还是图文时会自动改用另一种页面再试一次

### ④ 支付宝视频下载(生活号 / 视频号)
- 粘贴分享链接(含 `ur.lepudding.com` 这类第三方短链,会自动跟 302 判断落到哪个平台)、
  分享页 URL 或裸 `contentId`
- 纯 HTTPS 解析,不开窗口、不装证书:短链 → `contentId` → SOFA 网关接口
  `ContentWebGWController.list` → `gw.alipayobjects.com` CDN 直链
- 清晰度可换后缀枚举并逐个 HEAD 校验:`1080P`/`720P`/`480P` 各含 H.264 与 H.265,
  默认选 **1080P · H.264**(Windows 默认不带 HEVC 解码器,H.265 可能下得下来放不出来)
- 直链不校验 UA / Referer / Cookie,公开内容无需登录;单文件 mp4,不需要 ffmpeg 合并

### ⑤ 公众号图文 / 图片消息下载(无水印图集)
- 粘贴 `https://mp.weixin.qq.com/s/...` 文章链接(或分享文案)
- 纯 HTTPS 解析,不开窗口:图片消息(小绿书)的图片列表就在页面内联数据
  `picture_page_info_list` 里,每张带 `cdn_url`(压缩图)、`watermark_info`(水印图层)
  与 `original_info`(无水印原图,单张常 40MB+)
- **水印是客户端叠上去的图层,不在图片里**(已逐张核验):默认取 `original_info.cdn_url`
  原图,也可在界面切「压缩图」省空间;普通图文则取正文 `js_content` 里的 `data-src` 图片
- 不 eval 页面脚本:那个数组是 JS 字面量(裸键名 / 单引号 / `'2560' * 1`),
  模块用括号扫描 + 字段正则解析,不执行远端代码
- 图集存进以标题命名的子目录,`01.jpg` / `02.jpg`… 按成功顺序连续编号;
  页面封面一起存为 `封面.jpg`,排在最前、不占编号(优先 `msg_cdn_url`,
  没有就取 `og:image` / `twitter:image`;封面只有压缩版)
- 验证页(环境异常)、已删除、被屏蔽、链接参数错误(文章 ID 抄错)都会明确报错

### ⑥ Telegram 视频下载(公开频道帖)
- 粘贴 `https://t.me/频道名/帖号`(也认 `t.me/s/...`、`telegram.me/...`、
  `tg://resolve?domain=…&post=…`,以及分享文案里夹带的链接)
- 纯 HTTPS 解析,不要账号、不开窗口:单帖 widget 页
  `t.me/<频道>/<帖号>?embed=1&mode=tme` 直接吐出
  `cdnN.telesco.pe/xxx.mp4?token=...` —— 这个直链免 cookie / 免 Referer / 免 UA
- 顺带读时长、分辨率、封面,体积用 HEAD 探测(零流量);视频是单文件 mp4 带音轨,
  不需要 ffmpeg 合并。图片帖存为单张 jpg
- **前提是能连上 Telegram**:主进程的全局 `fetch`(undici)**不读系统代理**,
  所以模块自带 HTTP/1.1 客户端 + CONNECT 隧道,依次取环境变量 → Windows 系统代理
  (`reg query … ProxyServer`);直连也会试一次,海外机器或 TUN 模式的机器照样能用
- **限制**:只对「开了网页预览」的公开频道有效。关掉预览的频道,三种匿名入口
  (`t.me/频道/帖号`、`?embed=1`、`t.me/s/频道`)都只回一张引导页,没有任何媒体节点 ——
  此时软件会**自动回退到 MTProto 解析**(见 ⑦),前提是本机 Telegram Desktop 已登录;
  两条路都不通才报「解析失败」。文件附件(文档)同理,需要账号

### ⑦ Telegram 私密频道解析(MTProto,复用本机已登录会话)
- 公开解析(⑥)拿不到的媒体 —— **关闭网页预览的频道、私密频道、文件附件、完整原视频**
  —— 走这条路:从本机 Telegram Desktop 的 `tdata/D877F783D5D3EF8C` 提取已登录的
  MTProto 授权密钥,直接以你的账号身份连 Telegram 服务器解析和下载
- 纯 Node 实现的 MTProto 2.0 全链路,零外部依赖:
  `telegram-session.js`(解 tdata 授权)→ `telegram-mtproto.js`(加密传输层:
  AES-IGE + msg_key 派生、seq_no 奇偶语义、ack/容器/新会话处理)
  → `telegram-authkey.js`(无密钥时自主走 DH 握手生成新授权)
  → `telegram-dl.js`(TL 解析引擎:resolveUsername → getMessages → 分块 getFile)
- 使用:公开解析失败时**自动回退**到 MTProto,界面无感;识别到多个媒体时
  每个媒体单独选档(和公开解析一致),下载带进度条
- **大文件流式落盘**:分块直写磁盘(`.part` 临时文件写完改名),内存占用恒为单块 1MB,
  2GB+ 的视频也不会撑爆内存;解析容错按「要什么补什么」裁剪 —— 只有可下载的
  document/photo 媒体走严格 schema,网页预览/投票等不可下载媒体解析失败时
  只丢弃该条消息,不拖垮整个请求
- 前提:本机装了 Telegram Desktop **且已登录过**(不用输任何账号密码,只读 tdata);
  依旧需要能连上 Telegram(复用模块自带的 CONNECT 代理客户端)
- **限制**:不支持 CDN 重定向的文件(极少数官方大文件,会明确报错);
  `file_reference` 过期后需在客户端里重新打开该帖再试;
  跨 DC 文件自动 export/import 授权,已内置
- 实测:私密频道 2.3GB 单文件(关闭预览的频道)完整解析,分块下载经 ffmpeg 校验通过;
  流式落盘版另行用三个视频验证(落盘字节数 == 返回字节数,ffmpeg 全量解码零错误)

### ⑧ Telegram 本地缓存恢复(离线,私密频道也能取)
- 不联网、不要账号:**直接解本机 Telegram Desktop 落盘的加密缓存**
  (`tdata/user_data/cache` + `media_cache`)。网页预览被关掉的频道/群,
  只要在本机客户端里看过,磁盘上就有 —— 这条路不受「有没有开预览」限制
- 加密链:`key_datas` 里的本地密钥用「空口令派生密钥」包着(口令为空时 PBKDF2
  只迭代 1 次),缓存文件是 `TDEF` + 64 字节 salt + AES-256-CTR;
  key/iv 由本地密钥与 salt 各半做 SHA256 得到。开了应用锁的机器解不开,会明确提示
- 界面:进卡片自动探测 tdata(绿色版可手填路径)→ 扫描 → 缩略图墙 → 勾选 → 导出
  (按 `图片/`、`视频/`、`语音/` 分目录,顺带写 `index.html` 图片墙与 `manifest.json` 清单)
- **能拿到**:图片(jpg/png/webp/gif)、圆视频(webm)、语音 —— 完整原文件,
  首字节即原始 magic,不需要二次转码
- **拿不到**:长视频只有 8MB 分片,文件名是缓存键哈希、不含偏移,分片无法排序拼回整段;
  只有「索引(moov)在文件头」的能直接播,其余标注**缺索引**
- 实测本机 1.0GB 缓存:926 个文件 → 452 条可恢复(401 图 / 51 视频,其中 45 个能播),
  全量扫描约 2.5 秒;二次扫描命中文件指纹缓存(sizes+mtime)降到 0.3 秒

### ⑨ 微信视频号下载(实验性)
- 原理:本地 MITM 代理捕获视频号网页播放器的 feed 数据(含视频直链与 decodeKey),
  用微信官方解密模块(WASM,ISAAC64 密钥流)解密文件头 128KB,还原完整 MP4
- 使用:视频号卡片 → 启动捕获(首次自动安装本地证书)→ 完全重启微信 →
  打开/切换视频号视频 → 列表中点「下载」
- 下载完成后自动校验文件头;停止捕获会自动还原系统代理
- 兼容性说明:页面注入依赖微信前端结构,微信更新后可能失效

### ⑩ 微信表情包导出
- 把微信里收藏的全部自定义表情批量导出为图片文件(GIF/PNG/JPG)
- 原理:微信 4.x 本地表情文件是加密的,本功能调用开源工具
  [wxemoticon](https://github.com/liusheng22/export-wechat-emoji) 从运行中的微信进程
  提取数据库密钥 → 解密表情索引(emoticon.db)→ 从微信 CDN 下载并还原原图
- 使用:表情包导出卡片 → 检测环境(首次自动下载工具,约 3.7MB,SHA-256 校验)→ 开始导出
- 可选导出目录、分组方式;「跳过已存在」支持中断后续跑
- 已实测(微信 4.x / v0.3.0):无需管理员、无需退出微信;925 个表情约 2.5 分钟
- 注意:工具需读取微信进程内存,杀毒软件可能弹提示,请放行;微信大版本更新后可能短期失效
  (跟随上游工具更新,也可点「从本地 zip 安装」手动装新版)

## 运行要求

- Windows 10/11(理论上支持 macOS/Linux)
- Node.js ≥ 18(建议 20+,下载:https://nodejs.org )
- ffmpeg(可选,但封面/合并功能需要):优先用随包的 `@ffmpeg-installer`,其次程序目录
  (含 `data\ffmpeg\`、`ffmpeg\bin\`)下的 `ffmpeg.exe`,最后是系统 PATH。
  开发模式下若有 `npm install`,随包那份就在 `node_modules` 里,无需另装。

## 使用

```bash
npm install
npm start
```

或双击 `启动.bat`(自动安装依赖,已配置国内镜像加速)。

B 站相关功能需先登录(右上角「登录 B 站」);抖音/支付宝/Telegram/视频号无需登录 B 站。

## 目录结构

```
├─ main.js            # Electron 主进程:窗口、B站/抖音/支付宝接口、ffmpeg 定位、下载合并
├─ douyin-images.js   # 抖音图集:从 aweme 详情取图、去水印优先、批量落盘
├─ douyin-fetch.js    # 抖音分享页解析(纯 HTTPS)
├─ alipay-fetch.js    # 支付宝生活号/视频号解析(短链 302 → contentId → 网关接口 → CDN 直链)
├─ wechat-article.js  # 公众号图文/图片消息解析(内联图片数据 → 无水印原图,不 eval 远端 JS)
├─ telegram-fetch.js  # Telegram 公开频道帖解析(自带 CONNECT 代理客户端,主进程 fetch 不读系统代理)
├─ telegram-local.js  # Telegram Desktop 本地缓存解密/扫描/导出(key_datas + TDEF/AES-CTR)
├─ telegram-session.js   # 从 tdata 提取已登录的 MTProto 授权密钥
├─ telegram-mtproto.js   # MTProto 2.0 加密传输层(AES-IGE / msg_key / ack / 容器)
├─ telegram-authkey.js   # 无密钥时的 DH 握手,自主生成新授权
├─ telegram-dl.js        # MTProto 媒体解析与下载(TL 引擎 + 分块 getFile + 跨 DC)
├─ preload.js         # contextBridge: window.bili.*
├─ wxv-collect.js     # 微信视频号捕获全链路(代理装配/key 关联/分片合并/封面/缓存清理)
├─ wx-proxy.js        # 微信视频号本地 MITM 代理(证书、页面注入、feed 捕获)
├─ wxv-decrypt.js     # 视频号解密(官方 WASM + ISAAC64)
├─ emoji-export.js    # 微信表情包导出(包装开源工具 wxemoticon)
├─ renderer/          # 渲染层(主界面 + 取关独立窗口)
├─ test/              # 自检:renderer-test.js(假 DOM 跑真脚本)、local-test.js(真缓存导出)
├─ 启动.bat           # 一键启动
└─ package.json
```

`main.js` 只做装配:`require('./wxv-collect')({ app, ipcMain, shell, UA, sendToMain,
downloadStream, probeMedia, extractFrame })`;捕获相关的状态与函数都在模块内部,
启动时由 `wxv.recoverStaleProxy()` 自愈残留代理,退出时由 `wxv.shutdown()` 落盘并还原。

## 本地根证书与系统代理(必读)

视频号捕获依赖本地 MITM,涉及两处对系统的改动,都请知悉:

- **根证书**:首次捕获会在 `userData/wx-ca/` 生成本地根证书,点「安装证书」后进入
  **当前用户**「受信任的根证书颁发机构」(无需管理员)。装上期间,任何能读到
  `ca.key` 的本地进程都可以为任意域名签发有效证书,这是 MITM 的固有代价。
  不用时请点**「卸载证书」**移除(会一并清理早期版本留下的同名旧证书);
  该目录不要外传,`ca.key` 就是签发能力本身。
- **系统代理**:捕获期间会临时把系统代理指向 `127.0.0.1:8899`,正常退出会还原。
  若进程被强杀/断电导致残留,下次启动会自动检测并关闭(只处理指向本机 8899 的配置,
  不会动你自己设的代理)。也可以在「Internet 选项 → 连接 → 局域网设置」里手动关。

## 打包

```bash
npm run pack   # 免安装目录: dist/win-unpacked
npm run dist   # NSIS 安装包
```

打包要点:`@ffmpeg-installer/**` 必须 `asarUnpack`,否则 ffmpeg 在 asar 内会被
`fs.existsSync` 判为存在、但 `spawn` 一定 ENOENT(报错形如
`spawn ...\app.asar\node_modules\@ffmpeg-installer\win32-x64\ffmpeg.exe ENOENT`)。
绿色的便携版会把 userData 重定向到 exe 同级的 `data/`;开发模式沿用系统默认(AppData)。

新增的解析模块(`douyin-fetch.js` / `douyin-images.js` / `alipay-fetch.js` / `telegram-fetch.js` /
`telegram-local.js` / `telegram-session.js` / `telegram-mtproto.js` / `telegram-authkey.js` /
`telegram-dl.js`)必须列进
`package.json` 的 `build.files`,否则开发模式正常、打包后 `require` 直接找不到模块。

## 排障探头

双击启动看不到控制台,可以用带参数的探针把链路跑一遍,结果会写进
`userData/*-probe.json` 并弹窗显示:

```bash
# 抖音:链接识别 → 分享页 → 真实捕获(与界面点「识别」同一条路)
B站一键取关助手.exe --dy-probe "https://v.douyin.com/xxxx/"

# 支付宝:短链 → contentId → 接口 → 清晰度 → 真实下载
B站一键取关助手.exe --ap-probe "https://ur.lepudding.com/xxxx"

# 公众号:文章 → 图片消息内联数据 → 原图直链(HEAD 校验前两张,不整包下载)
B站一键取关助手.exe --wxarticle-probe "https://mp.weixin.qq.com/s/xxxx"

# Telegram:代理连通性 → widget 页 → 直链 → 真实下载
B站一键取关助手.exe --tg-probe "https://t.me/channel/123"

# Telegram 本地缓存:找 tdata → 解本地密钥 → 扫描统计(可带自定义 tdata 路径)
B站一键取关助手.exe --tglocal-probe "D:\Telegram Desktop	data"

# 视频号:证书/代理/缓存体检
B站一键取关助手.exe --wxv-diagnose
```

Telegram 探头会先记录 `net` 段(当前识别到的代理、`t.me` / `telesco.pe` 的连通结果),
九成的"解析失败"其实卡在这里,先看这一段比看报错有用。

## 自检

```bash
node test/local-test.js       # 用本机真缓存导出几张图/一个视频,核对落盘与清单
node test/renderer-test.js    # 假 DOM 里跑真 renderer 脚本,模拟点选/筛选/导出
```

`test/renderer-test.js` 是为了绕开「本机 electron.exe 起不来」而写的:它自带一个
最小 DOM(选择器、classList、dataset、事件冒泡、innerHTML 解析),把
`common.js`/`app.js`/`tgl-local.js` 原样跑起来,断言界面流程 —— 真机点不到的分支
(扫描失败、缩略图抽帧失败、二次导出跳过)靠它兜。

## 免责声明

本项目为开源项目,仅用于技术交流学习和研究的目的。请遵守法律法规,请勿用作任何非法用途,否则造成一切后果自负。
