// 把纯函数 client 脚本（format.js）在 CJS 测试里求值，导出其顶层函数。
const fs = require('node:fs')
const vm = require('node:vm')
const code = fs.readFileSync(require('node:path').join(__dirname, '..', 'src', 'format.js'), 'utf8')
const sandbox = {}
vm.createContext(sandbox)
vm.runInContext(code + '\n;globalThis.__out={fdSize,fdTime,fdKind,fdBase,fdPct};', sandbox)
module.exports = sandbox.__out
