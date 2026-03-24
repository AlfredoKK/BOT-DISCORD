module.exports = {
  apps: [
    {
      name: 'discord-support',
      script: 'src/index.js',
      watch: false,
      restart_delay: 2000,
      max_restarts: 50,
      env: {
        NODE_ENV: 'production',
      },
    },
  ],
};
