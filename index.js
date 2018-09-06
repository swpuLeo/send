/**
 * Module dependencies.
 */

const debug = require('debug')('koa-send')
// resolve-path 模块
// 防止解析的相对路径，访问到根路径以外
// https://github.com/pillarjs/resolve-path#readme
const resolvePath = require('resolve-path')
const createError = require('http-errors')
const assert = require('assert')
const fs = require('mz/fs')

/**
 * @ Leo
 * UpdateAt 2018/09/06
 * path 模块的方法：
 * 1. normalize()
 * 用于规范化给定的 path
 * 2. basename()
 * 返回 path 的最后一部分
 * path.basename('/foo/bar/baz/asdf/quux.html');
 * // 返回: 'quux.html'
 * path.basename('/foo/bar/baz/asdf/quux.html', '.html');
 * // 返回: 'quux'
 * 3. extname()
 * 返回文件的扩展名
 * 4. resolve()
 * 把一个路径或路径片段的序列解析为一个绝对路径
 * 给定的路径的序列是从右往左被处理的，后面每个 path 被依次解析，直到构造完成一个绝对路径
 * 5. parse()
 * 返回一个对象，对象的属性表示 path 的元素
 * path.parse('/home/user/dir/file.txt');
 * // 返回:
 * // { root: '/',
 * //   dir: '/home/user/dir',
 * //   base: 'file.txt',
 * //   ext: '.txt',
 * //   name: 'file' }
 * 6. sep()
 * 提供了平台特定的路径片段分隔符
 * 'foo/bar/baz'.split(path.sep);
 * // 返回: ['foo', 'bar', 'baz']
 */
const {
  normalize,
  basename,
  extname,
  resolve,
  parse,
  sep
} = require('path')

/**
 * Expose `send()`.
 */

module.exports = send

/**
 * Send file at `path` with the
 * given `options` to the koa `ctx`.
 *
 * @param {Context} ctx
 * @param {String} path
 * @param {Object} [opts]
 * @return {Function}
 * @api public
 */

async function send (ctx, path, opts = {}) {
  assert(ctx, 'koa context required')
  assert(path, 'pathname required')

  // options
  debug('send "%s" %j', path, opts)
  // opts.root 根路径，静态资源访问的根路径
  const root = opts.root ? normalize(resolve(opts.root)) : ''
  // 是否有结尾反斜杠
  const trailingSlash = path[path.length - 1] === '/'
  path = path.substr(parse(path).root.length)
  const index = opts.index
  const maxage = opts.maxage || opts.maxAge || 0
  // 表明该资源不可变，可永久存储
  const immutable = opts.immutable || false
  // 允许访问隐藏文件
  const hidden = opts.hidden || false
  // 允许使用结尾反斜杠
  const format = opts.format !== false
  // 扩展名数组
  const extensions = Array.isArray(opts.extensions) ? opts.extensions : false
  // 是否 brotli 压缩
  const brotli = opts.brotli !== false
  // 是否 gzip 压缩
  const gzip = opts.gzip !== false
  // 设置头部字段，并且 setHeaders 应该为一个函数
  const setHeaders = opts.setHeaders

  if (setHeaders && typeof setHeaders !== 'function') {
    throw new TypeError('option setHeaders must be function')
  }

  // normalize path
  // 解析路径
  path = decode(path)

  // 对于不能解析的路径，返回 400，Bad Request
  if (path === -1) return ctx.throw(400, 'failed to decode')

  // index file support
  // 对 index 文件的支持，需要结尾反斜杠的存在
  if (index && trailingSlash) path += index

  // 安全性考虑，防止解析到根路径以外的目录中
  // 需要阅读 resolve-path 模块的实现原理
  path = resolvePath(root, path)

  // hidden file support, ignore
  // 忽略隐藏文件
  if (!hidden && isHidden(root, path)) return

  let encodingExt = ''
  // serve brotli file when possible otherwise gzipped file when possible
  // 优先使用 brotli 压缩，然后使用 gzip 压缩
  // 如果请求了 br 压缩文件，并且开启了 br 压缩，并且存在请求文件的 br 压缩文件
  // 那么设置响应内容编码为 br
  // 并且移除 Content-length
  // 设置压缩扩展名为 .br
  // gzip 同理
  if (ctx.acceptsEncodings('br', 'identity') === 'br' && brotli && (await fs.exists(path + '.br'))) {
    path = path + '.br'
    ctx.set('Content-Encoding', 'br')
    ctx.res.removeHeader('Content-Length')
    encodingExt = '.br'
  } else if (ctx.acceptsEncodings('gzip', 'identity') === 'gzip' && gzip && (await fs.exists(path + '.gz'))) {
    path = path + '.gz'
    ctx.set('Content-Encoding', 'gzip')
    ctx.res.removeHeader('Content-Length')
    encodingExt = '.gz'
  }

  // 匹配 . 并且不包括 / 的零个或多个字符
  if (extensions && !/\.[^/]*$/.exec(path)) {
    // 复制一份扩展名数组
    const list = [].concat(extensions)
    for (let i = 0; i < list.length; i++) {
      let ext = list[i]
      if (typeof ext !== 'string') {
        throw new TypeError('option extensions must be array of strings or false')
      }
      // 容错处理，如果扩展名不是以 . 开头的字符串，手动添加 .
      if (!/^\./.exec(ext)) ext = '.' + ext
      // 查找是否有以扩展名结尾的文件
      if (await fs.exists(path + ext)) {
        path = path + ext
        break
      }
    }
  }

  // stat
  let stats
  try {
    stats = await fs.stat(path)

    // Format the path to serve static file servers
    // and not require a trailing slash for directories,
    // so that you can do both `/directory` and `/directory/`
    // 判断是否是目录
    // 是目录，就进入目录找
    if (stats.isDirectory()) {
      if (format && index) {
        path += '/' + index
        stats = await fs.stat(path)
      } else {
        return
      }
    }
  } catch (err) {
    // 处理异常
    const notfound = ['ENOENT', 'ENAMETOOLONG', 'ENOTDIR']
    if (notfound.includes(err.code)) {
      throw createError(404, err)
    }
    err.status = 500
    throw err
  }

  if (setHeaders) setHeaders(ctx.res, path, stats)

  // stream
  // 以流的形式返回
  ctx.set('Content-Length', stats.size)
  // 设置缓存
  if (!ctx.response.get('Last-Modified')) ctx.set('Last-Modified', stats.mtime.toUTCString())
  if (!ctx.response.get('Cache-Control')) {
    const directives = ['max-age=' + (maxage / 1000 | 0)]
    if (immutable) {
      directives.push('immutable')
    }
    ctx.set('Cache-Control', directives.join(','))
  }
  // 设置响应 Content-Type 通过 mime 字符串或文件扩展名
  if (!ctx.type) ctx.type = type(path, encodingExt)
  ctx.body = fs.createReadStream(path)

  return path
}

/**
 * Check if it's hidden.
 */

function isHidden (root, path) {
  path = path.substr(root.length).split(sep)
  for (let i = 0; i < path.length; i++) {
    if (path[i][0] === '.') return true
  }
  return false
}

/**
 * File type.
 */

function type (file, ext) {
  return ext !== '' ? extname(basename(file, ext)) : extname(file)
}

/**
 * Decode `path`.
 */
/**
 * @ Leo
 * UpdateAt 2018/09/06
 * encodeURIComponent() 通常用于对 URI 中的查询字符串进行编码，它会将所有的非标准字符进行编码，
 * 而 encodeURI() 通常适用于对整个 URI 进行编码，不会对属于 URI 的特殊字符编码，如冒号、正斜杠、问号、井字号
 * 相应地，decodeURIComponent() 用于解码
 */
function decode (path) {
  try {
    return decodeURIComponent(path)
  } catch (err) {
    return -1
  }
}
