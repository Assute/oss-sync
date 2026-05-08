# oss-sync

阿里云 OSS 多存储同步上传网页，零依赖 Node.js 版。

## 功能

- 账号密码登录
- 只填 `AccessKeyId` 和 `AccessKeySecret`
- 自动发现当前账号下的 Bucket
- 上传时同步到所有 Bucket
- 列表里同名文件只显示一条
- 复制时按行复制所有存储地址
- 编辑 / 删除时同步作用到所有存储

## 演示图

![演示图](https://pic.sl.al/gdrive/pic/2026-05-08/fileid_1R7qkNYMNSevitfeYBLKiVgTJYCewsu6C_image.png)

## 快速开始

```bash
git clone https://github.com/Assute/oss-sync.git
cd oss-sync
cp config.example.json config.json
node server.js
```

打开：

```text
http://127.0.0.1:5300
```

## 配置

编辑 `config.json`：

```json
{
  "server": {
    "host": "0.0.0.0",
    "port": 5300
  },
  "auth": {
    "enabled": true,
    "username": "admin",
    "password": "change-this-password"
  },
  "oss": {
    "accessKeyId": "your-access-key-id",
    "accessKeySecret": "your-access-key-secret",
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

### 需要填写

- `auth.username`
- `auth.password`
- `oss.accessKeyId`
- `oss.accessKeySecret`

## 登录说明

- 访问网站时会先进入登录页
- 登录成功后才能进入上传和文件管理页面
- 登录账号和密码来自 `config.json`

## 同步逻辑

### 上传

上传一个文件时，会自动同步到所有 Bucket。

### 列表

多个 Bucket 中的同名文件，只显示一个文件名。

### 复制

复制时会把所有存储地址一起复制，格式为一行一个地址。

如果某个 Bucket 开启了传输加速，复制时会优先使用加速地址。

### 编辑 / 删除

- 编辑保存：同步保存到所有存储
- 删除文件：同步删除所有存储中的同名文件

## 文件

- `server.js`：零依赖后端，直接调用 OSS REST API
- `public/index.html`：主页面
- `public/login.html`：登录页面
- `config.example.json`：配置示例
- `config.json`：你本地自己的配置，已加入 `.gitignore`

## 说明

- 不需要 `npm install`
- 默认端口是 `5300`
- 如果 Bucket 是私有读，复制出来的地址不一定可以直接打开
