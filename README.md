# oss-sync

阿里云 OSS 多存储同步上传网页，零依赖 Node.js 版。

## 功能

- 只填 `AccessKeyId` 和 `AccessKeySecret`
- 自动发现当前账号下的 Bucket
- 上传时同步到所有 Bucket
- 列表里同名文件只显示一条
- 复制时按行复制所有存储地址
- 编辑 / 删除时同步作用到所有存储

## 演示图

![演示图](https://pic.sl.al/gdrive/pic/2026-05-08/fileid_1R7qkNYMNSevitfeYBLKiVgTJYCewsu6C_image.png)

## 运行环境

- Node.js 18+
- 不需要 `npm install`

## 启动

```powershell
cd d:\桌面\study\ai\oss-sync
copy config.example.json config.json
node server.js
```

打开：

```text
http://127.0.0.1:5300
```

## 配置

先复制示例配置：

```powershell
copy config.example.json config.json
```

再编辑 `config.json`：

```json
{
  "server": {
    "host": "0.0.0.0",
    "port": 5300
  },
  "oss": {
    "accessKeyId": "你的AccessKeyId",
    "accessKeySecret": "你的AccessKeySecret",
    "secure": true
  },
  "upload": {
    "maxFileSizeMB": 100
  },
  "list": {
    "maxKeys": 200
  }
}
```

## 说明

- `config.json` 已加入 `.gitignore`，不会被提交
- 仓库内只保留 `config.example.json`
- 如果某个 Bucket 开启传输加速，复制地址时会优先使用加速地址

## 文件

- `server.js`：零依赖后端，直接调用 OSS REST API
- `public/index.html`：前端页面
- `config.example.json`：配置示例
