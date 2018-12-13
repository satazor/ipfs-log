'use strict'

const glob = require('glob')
const webpack = require('webpack')
const path = require('path')

module.exports = {
  // TODO: put all tests in a .js file that webpack can use as entry point
  entry: glob.sync('./test/*.spec.js', { 'ignore': ['./test/replicate.spec.js'] }),
  output: {
    filename: './test/browser/bundle.js'
  },
  target: 'web',
  devtool: 'source-map',
  node: {
    console: false,
    process: 'mock',
    Buffer: true
  },
  plugins: [
    new webpack.DefinePlugin({
      'process.env': {
        'NODE_ENV': JSON.stringify(process.env.NODE_ENV)
      }
    })
  ],
  externals: {
    fs: '{}',
    rimraf: '{ sync: () => {} }',
    'idb-readable-stream': '{}'
  },
  resolve: {
    modules: [
      'node_modules',
      path.resolve(__dirname, '../node_modules')
    ]
  },
  resolveLoader: {
    modules: [
      'node_modules',
      path.resolve(__dirname, '../node_modules')
    ],
    moduleExtensions: ['-loader']
  },
  module: {
    rules: [
      {
        test: /\.json$/,
        loader: 'json-loader'
      },
      // For inlining the fixture keys in browsers tests
      {
        test: /userA|userB|userC|userD$/,
        loader: 'json-loader'
      }
    ]
  }
}
