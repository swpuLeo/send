
# koa-send

Static file serving middleware.

:sparkles: [koajs/send](https://github.com/koajs/send)

## 整体思路

通过阅读 koajs/send 的源码，在设计静态资源服务器的时候，具体的步骤如下：
- 解析请求路径
- 判断是否启动压缩文件
- 处理扩展名数组
- 查找文件并处理异常
- 设置响应头部并返回文件

相关配置项：

对于缓存的，都属于 Cache-Control 字段：
- maxage | 0
- immutable | false

对于压缩的：
- brotli | true
- gzip | true

对于路径的：
- hidden | false
- root
- index
- format | true
- extensions | false

其他：

setHeaders 这是一个函数。这个函数接收三个参数：`res, path, stats`，分别是响应对象、路径和文件信息对象。

需要注意的是：只能通过这个方法来设置 `Cache-Control` 或者 `Last-Modified` 字段。对于其他字段，可以直接在调用 `send()` 前去设置。比如：
```js
const send = require('koa-send');
const Koa = require('koa');
const app = new Koa();


app.use(async (ctx) => {
  if ('/' == ctx.path) return ctx.body = 'Try GET /package.json';
  ctx.set('Header-Key', 'Header-Value')
  await send(ctx, ctx.path);
})
```


### 解析请求路径
对于请求路径的解析，在 koajs/send 中有 5 步：
```js
path = path.substr(parse(path).root.length)

path = decode(path)
if (path === -1) return ctx.throw(400, 'failed to decode')

if (index && trailingSlash) path += index

path = resolvePath(root, path)

if (!hidden && isHidden(root, path)) return
```
1、调用 `path.parse()` 对 path 进行解析，返回一个对象：
```js
path.parse('/home/user/dir/file.txt')
{
 root: '/',
 dir: '/home/user/dir',
 base: 'file.txt',
 ext: '.txt',
 name: 'file'
}
```
这一步将得到一个相对路径，相对于 root。

2、调用 `decode()` 函数：
```js
function decode (path) {
  try {
    return decodeURIComponent(path)
  } catch (err) {
    return -1
  }
}
```
这一步，主要就是对 path 进行解码，如果不能解码，则说明这个 path 存在不合法的字符，那么抛出一个 400 错误。

3、如果配置了 index 项，并且 path 中存在结尾反斜杠，那么对 path 加上指定的 index。

4、使用 `resolve-path` 模块进行解析 path，这个第三方模块防止了 path 相对根路径以外，从而可能造成安全问题。[resolve-path](https://github.com/pillarjs/resolve-path)。

5、是对隐藏文件的处理，直接 return。

### 判断是否启动压缩文件

```js
if (ctx.acceptsEncodings('br', 'identity') === 'br' && brotli && (await fs.exists(path + '.br'))) {
  path = path + '.br'
  ctx.set('Content-Encoding', 'br')
  ctx.res.removeHeader('Content-Length')
  encodingExt = '.br'
}
```
对于启动压缩文件有三个条件：

1、`ctx.acceptsEncodings('br', 'identity') === 'br'`
对于请求首部字段中的 Accept-Encoding （告知服务器客户端可以接受的内容编码以及内容编码优先级）。而 ctx.acceptsEncoding() 可以返回最适合的编码字符串，identity 为默认不执行压缩算法。所以这个条件就是说 **浏览器优先接受 br 压缩算法**。

2、`brotli`
这个是配置项 `opts.brotli`，布尔值，表示后台配置中是否开启了 brotli 压缩算法。

3、`await fs.exists(path + '.br')`
第三个条件，是查找目录中是否存在指定文件的 br 算法压缩文件。

需要同时满足这三个条件，那么就把 path 设置为 path + '.br' 即访问指定文件的压缩文件。也需要设置响应首部 Content-Enconding 来指明返回内容的压缩类型，同时移除 Content-length 字段。最后，将压缩扩展名保存起来，供后面使用。

gzip 压缩同理，不过在 koajs/send 中，优先使用 br 压缩。

### 处理扩展名数组
在配置中还有一个选项是 `extensions`。它是一个扩展名数组，比如 `['.js', '.node', '.json']`。在处理这个选项时，思路也比较简单。

满足 `extensions && !/\.[^/]*$/.exec(path)` 条件就可以进行指定扩展名的查找。这个条件的意思是当存在 `extensions` 数组并且当前 `path` 不具有扩展名，然后就去迭代扩展名数组，依次查找是否有以 `path + 扩展名` 结尾的文件，有的话，就为 `path` 加上扩展名。

本质上，这一步和上一步压缩文件，也都是在处理 `path`。

### 查找文件以及处理异常
查找文件是重头戏了。这里需要使用到 fs.Stats 这个类，它提供了一个文件的信息。

```js
let stats = await fs.stat(path)
```

调用 `isDirectory()` 判断当前路径是否是目录，如果是目录，需要结合配置中的 `format` 和 `index` 继续查找，并返回这个文件信息：

```js
if (stats.isDirectory()) {
  if (format && index) {
    path += '/' + index
    stats = await fs.stat(path)
  } else {
    return
  }
}
```

对于异常处理，koajs/send 只有两种，一种是 404，既没有找到指定路径的资源；另一种，默认为 500，服务器内部错误。

### 设置响应头部并返回
设置响应头部，首先调用配置项中的 setHeaders() 函数。接着写入 Content-Length，因为之前如果使用压缩文件，这个字段就被删过，需要在这里被重新设置。

然后响应头部中有两个很关键的字段，用于缓存资源。一个是 Last-Modified，另一个是 Cache-Control。Cache-Control 中有一个 immutable 字段，它是一个可配置项，表示该资源是否可永久缓存。

然后设置响应 Content-Type 通过 mime 字符串或文件扩展名。

最后，调用 `ctx.body = fs.createReadStream(path)` 以流式返回文件。

