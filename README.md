# oss-sync

阿里云 OSS 多存储同步上传网页，零依赖 Node.js 版。

- 只填 `AccessKeyId` 和 `AccessKeySecret`
- 自动发现当前账号下的 Bucket
- 上传时同步到所有 Bucket
- 列表里同名文件只显示一条
- 复制时按行复制所有存储地址
- 编辑 / 删除时同步作用到所有存储

## 演示图

![演示图](https://pic.sl.al/gdrive/pic/2026-05-08/fileid_1R7qkNYMNSevitfeYBLKiVgTJYCewsu6C_image.png)

## 仓库地址

```text
https://github.com/Assute/oss-sync.git
```

## 服务器安装命令（Ubuntu / Debian）

### 1）安装基础工具

```bash
sudo apt update
sudo apt install -y curl git
```

### 2）安装 nvm

```bash
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.4/install.sh | bash
```

执行完后重新加载 shell：

```bash
export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"
```

### 3）安装 Node.js 24 LTS

```bash
nvm install 24
nvm alias default 24
node -v
```

### 4）克隆项目

```bash
git clone https://github.com/Assute/oss-sync.git
cd oss-sync
```

### 5）复制配置文件

```bash
cp config.example.json config.json
```

然后编辑：

```bash
nano config.json
```

把下面两项改成你自己的：

- `oss.accessKeyId`
- `oss.accessKeySecret`

## 启动项目

```bash
node server.js
```

默认端口：

```text
5300
```

浏览器访问：

```text
http://服务器IP:5300
```

## 后台运行（可选）

```bash
nohup node server.js > app.log 2>&1 &
```

查看日志：

```bash
tail -f app.log
```

## 放行端口（如果开启了防火墙）

```bash
sudo ufw allow 5300/tcp
```

## 配置文件示例

```json
{
  "server": {
    "host": "0.0.0.0",
    "port": 5300
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

## 项目文件

- `server.js`：零依赖后端，直接调用 OSS REST API
- `public/index.html`：前端页面
- `config.example.json`：配置示例
- `config.json`：你本地自己的配置，已加入 `.gitignore`

## 说明

- 不需要 `npm install`
- 如果某个 Bucket 开启了传输加速，复制地址时优先使用加速地址
- 如果 Bucket 是私有读，复制出来的地址不一定可以直接打开
