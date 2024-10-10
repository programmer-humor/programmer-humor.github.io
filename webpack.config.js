const webpack = require('webpack');

module.exports = {
  // ... 다른 설정들 ...
  plugins: [
    new webpack.DefinePlugin({
      'process.env.REAL_API_HOST': JSON.stringify(process.env.REAL_API_HOST      )
    })
  ]
};