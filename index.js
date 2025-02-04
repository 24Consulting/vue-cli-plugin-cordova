const spawn = require('cross-spawn')
const { info, error } = require('@vue/cli-shared-utils')
const fs = require('fs')
const portfinder = require('portfinder')
const address = require('address')
const defaults = require('./defaults')
const defaultServe = require('./default-serve')

const defaultModes = {
  'cordova-serve-android': 'development',
  'cordova-build-android': 'production',
  'cordova-serve-ios': 'development',
  'cordova-build-ios': 'production',
  'cordova-serve-browser': 'development',
  'cordova-build-browser': 'production'
}

module.exports = (api, options) => {
  const cordovaPath = options.pluginOptions.cordovaPath || defaults.cordovaPath
  const srcCordovaPath = api.resolve(cordovaPath)

  const getPlatformPath = platform => {
    return api.resolve(`${cordovaPath}/platforms/${platform}`)
  }

  const getPlatformPathWWW = platform => {
    return api.resolve(`${cordovaPath}/platforms/${platform}/platform_www`)
  }

  const getCordovaPathConfig = () => {
    return api.resolve(`${cordovaPath}/config.xml`)
  }

  const cordovaRun = (platform, pathBuildConfig) => {
    // cordova run platform
    info(`executing "cordova run ${platform} --buildConfig ${pathBuildConfig}" in folder ${srcCordovaPath}`)
    return spawn.sync('cordova', [
      'run',
      platform,
      `--buildConfig=${pathBuildConfig}`
    ], {
      cwd: srcCordovaPath,
      env: process.env,
      stdio: 'inherit', // pipe to console
      encoding: 'utf-8'
    })
  }

  const cordovaPrepare = () => {
    // cordova run platform
    info(`executing "cordova prepare in folder ${srcCordovaPath}`)
    return spawn.sync('cordova', [
      'prepare'
    ], {
      cwd: srcCordovaPath,
      env: process.env,
      stdio: 'inherit', // pipe to console
      encoding: 'utf-8'
    })
  }

  const cordovaBuild = (platform, release = true, device = false, pathBuildConfig = '') => {
    // cordova run platform
    const cordovaMode = release ? '--release' : '--debug'

    var cordovaArgs = []
    cordovaArgs.push('build')
    cordovaArgs.push(platform)
    cordovaArgs.push(cordovaMode)
    cordovaArgs.push(`--buildConfig=${pathBuildConfig}`)
    if (device)
      cordovaArgs.push('--device')
    if (release)
      cordovaArgs.push('--verbose')

    info(`executing "cordova ${cordovaArgs.join(' ')}" in folder ${srcCordovaPath}`)
    return spawn.sync('cordova', cordovaArgs, {
      cwd: srcCordovaPath,
      env: process.env,
      stdio: 'inherit', // pipe to console
      encoding: 'utf-8'
    })
  }

  const cordovaClean = () => {
    // cordova clean
    info(`executing "cordova clean" in folder ${srcCordovaPath}`)
    return spawn.sync('cordova', [
      'clean'
    ], {
      cwd: srcCordovaPath,
      env: process.env,
      stdio: 'inherit', // pipe to console
      encoding: 'utf-8'
    })
  }

  const cordovaJSMiddleware = platform => {
    return (req, res, next) => {
      if (req.url !== '/') {
        const filePath = getPlatformPathWWW(platform) + req.url
        try {
          if (fs.existsSync(filePath)) {
            const fileContent = fs.readFileSync(filePath, 'utf-8')
            res.send(fileContent)
            return
          }
        } catch (err) {
        }
      }
      next()
    }
  }

  const cordovaContent = (resetNavigation, url) => {
    const cordovaConfigPath = getCordovaPathConfig()
    let cordovaConfig = fs.readFileSync(cordovaConfigPath, 'utf-8')
    let lines = cordovaConfig.split(/\r?\n/g).reverse()
    const regexContent = /\s+<content/
    const contentIndex = lines.findIndex(line => line.match(regexContent))
    const allowNavigation = `<allow-navigation href="${url}" />`
    if (contentIndex >= 0) {
      if (resetNavigation) {
        lines[contentIndex] = `    <content src="index.html" />`
        lines = lines.filter(line => !line.includes(allowNavigation))
      } else {
        lines[contentIndex] = `    <content src="${url}" />`
        lines.splice(contentIndex, 0, allowNavigation)
      }
    }

    cordovaConfig = lines.reverse().join('\n')
    fs.writeFileSync(cordovaConfigPath, cordovaConfig)
  }

  const runServe = async (platform, args) => {
    const availablePlatforms = []
    const platforms = defaults.platforms

    platforms.forEach(platform => {
      const platformPath = getPlatformPath(platform)
      if (fs.existsSync(platformPath)) {
        availablePlatforms.push(platform)
      }
    })

    if (availablePlatforms.includes(platform)) {
      // add cordova.js, define process.env.CORDOVA_PLATFORM
      chainWebPack(platform)
      // Add js middleware
      configureDevServer(platform)

      const projectDevServerOptions = options.devServer || {}
      // resolve server options
      const open = false // browser does not need to be opened
      const https = false // cordova webpage must be served via http
      const protocol = https ? 'https' : 'http'
      const host = args.host || process.env.HOST || projectDevServerOptions.host || defaultServe.host
      let port = args.port || process.env.PORT || projectDevServerOptions.port || defaultServe.port
      portfinder.basePort = port
      port = await portfinder.getPortPromise()
      const publicArg = args.public || projectDevServerOptions.public
      const defaultPublicURL = `${protocol}://${address.ip()}:${port}`
      const rawPublicUrl = publicArg || defaultPublicURL
      const publicUrl = rawPublicUrl
        ? /^[a-zA-Z]+:\/\//.test(rawPublicUrl)
          ? rawPublicUrl
          : `${protocol}://${rawPublicUrl}`
        : null

      const serveArgs = {
        open,
        host,
        port,
        https,
        public: publicArg
      }
      // npm run serve
      const server = await api.service.run('serve', serveArgs)

      // on kill, reset cordova config.xml
      const signals = ['SIGINT', 'SIGTERM']
      signals.forEach(signal => {
        process.on(signal, () => {
          cordovaContent(true, publicUrl)
        })
      })

      // set content url to devServer
      info(`updating cordova config.xml content to ${publicUrl}`)
      cordovaContent(false, publicUrl)

      cordovaClean()

      cordovaRun(platform, args.pathBuildConfig)

      return server
    } else {
      if (availablePlatforms.length === 0) {
        error(`No platforms installed in '${srcCordovaPath}', please execute "cordova platform add ${platform}" in ${srcCordovaPath}`)
      } else {
        error(`Missing platform '${platform}', please execute "cordova platform add ${platform}" in ${srcCordovaPath}`)
      }
    }
  }

  const runBuild = async (platform, args) => {
    // add cordova.js, define process.env.CORDOVA_PLATFORM
    chainWebPack(platform)
    // set build output folder
    args.dest = cordovaPath + '/www'
    // build
    await api.service.run('build', args)
    // cordova clean
    await cordovaClean()
    // cordova build --release (if you want a build debug build, use cordovaBuild(platform, false)
    await cordovaBuild(platform, args.release, args.device, args.pathBuildConfig)
  }

  const runPrepare = async (args) => {
    // add cordova.js, define process.env.CORDOVA_PLATFORM
    chainWebPack(null)
    // set build output folder
    args.dest = cordovaPath + '/www'
    // build
    await api.service.run('build', args)

    // cordova prepare
    await cordovaPrepare()
  }

  const runPrepareWWW = async (platform, args) => {
    // add cordova.js, define process.env.CORDOVA_PLATFORM
    chainWebPack(platform)
    // set build output folder
    args.dest = cordovaPath + '/www'
    // build
    await api.service.run('build', args)
  }

  const configureDevServer = platform => {
    api.configureDevServer(app => {
      // /cordova.js should resolve to platform cordova.js
      app.use(cordovaJSMiddleware(platform))
    })
  }

  const chainWebPack = platform => {
    api.chainWebpack(webpackConfig => {
      // add cordova.js to index.html
      webpackConfig.plugin('cordova')
                .use(require('html-webpack-include-assets-plugin'), [{
                  assets: 'cordova.js',
                  append: false,
                  publicPath: false
                }])

      // process.env.CORDOVA_PLATFORM = platform
      if (platform !== null) {
        webpackConfig.plugin('define')
                  .tap(args => {
                    const { 'process.env': env, ...rest } = args[0]
                    return [{
                      'process.env': Object.assign(
                        {},
                        env,
                        {
                          CORDOVA_PLATFORM: '\'' + platform + '\''
                        }
                      ),
                      ...rest
                    }]
                  })
      }

    })
  }

  api.registerCommand('cordova-serve-android', async args => {
    return await runServe('android', args)
  })

  api.registerCommand('cordova-build-android', async args => {
    return await runBuild('android', args)
  })

  api.registerCommand('cordova-serve-ios', async args => {
    return await runServe('ios', args)
  })

  api.registerCommand('cordova-prepare', async args => {
    return await runPrepare(args)
  })

  api.registerCommand('cordova-build-ios', async args => {
    return await runBuild('ios', args)
  })

  api.registerCommand('cordova-prepare-www-ios', async args => {
    return await runPrepareWWW('ios', args)
  })

  api.registerCommand('cordova-prepare-www-android', async args => {
    return await runPrepareWWW('android', args)
  })

  api.registerCommand('cordova-serve-browser', async args => {
    args.open = true
    const platform = 'browser'
    chainWebPack(platform)
    configureDevServer(platform)
    return await api.service.run('serve', args)
  })
  api.registerCommand('cordova-build-browser', async args => {
    return await runBuild('browser', args)
  })
}

module.exports.defaultModes = defaultModes
