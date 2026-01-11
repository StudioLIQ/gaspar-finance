/** @type {import('next').NextConfig} */
const path = require('path');

const nextConfig = {
  reactStrictMode: true,
  webpack: (config, { dev }) => {
    if (dev) {
      config.watchOptions = {
        ...(config.watchOptions || {}),
        ignored: [
          '**/node_modules/**',
          '**/.git/**',
          path.resolve(__dirname, '../node_modules/**'),
          path.resolve(__dirname, '../artifacts/**'),
          path.resolve(__dirname, '../broadcast/**'),
          path.resolve(__dirname, '../cache/**'),
          path.resolve(__dirname, '../out/**'),
          path.resolve(__dirname, '../deployments/**'),
          path.resolve(__dirname, '../docs/**'),
        ],
      };
    }
    return config;
  },
};

module.exports = nextConfig;
