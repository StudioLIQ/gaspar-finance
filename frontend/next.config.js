/** @type {import('next').NextConfig} */
const path = require('path');

const nextConfig = {
  reactStrictMode: true,
  webpack: (config, { dev }) => {
    if (dev) {
      config.watchOptions = {
        ...(config.watchOptions || {}),
        poll: 1000,
        aggregateTimeout: 300,
        ignored: [
          '**/node_modules/**',
          '**/.git/**',
          '**/.next/**',
          path.resolve(__dirname, '../node_modules/**'),
          path.resolve(__dirname, '../artifacts/**'),
          path.resolve(__dirname, '../broadcast/**'),
          path.resolve(__dirname, '../cache/**'),
          path.resolve(__dirname, '../out/**'),
          path.resolve(__dirname, '../deployments/**'),
          path.resolve(__dirname, '../docs/**'),
          path.resolve(__dirname, '../figures/**'),
          path.resolve(__dirname, '../keys/**'),
          path.resolve(__dirname, '../casper/**'),
          path.resolve(__dirname, '../config/**'),
          path.resolve(__dirname, '../scripts/**'),
        ],
      };
    }
    return config;
  },
};

module.exports = nextConfig;
