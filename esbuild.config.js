import { build } from 'esbuild';
import fs from 'fs';
import path from 'path';

const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));

const baseConfig = {
  entryPoints: ['bin/ccrotate.js'],
  bundle: true,
  platform: 'node',
  target: 'node18',
  format: 'esm', 
  outfile: 'dist/cli.js',
  treeShaking: true,
  packages: 'external',
  define: {
    'process.env.CCROTATE_VERSION': JSON.stringify(pkg.version)
  },
  plugins: [
    {
      name: 'clean-and-prepare',
      setup(build) {
        build.onStart(() => {
          // Clean dist directory
          if (fs.existsSync('dist')) {
            fs.rmSync('dist', { recursive: true, force: true });
          }
          fs.mkdirSync('dist', { recursive: true });
        });
      }
    },
    {
      name: 'copy-files',
      setup(build) {
        build.onEnd(() => {
          // Copy necessary files
          const filesToCopy = ['LICENSE', 'README.md'];
          
          filesToCopy.forEach(file => {
            if (fs.existsSync(file)) {
              fs.copyFileSync(file, path.join('dist', file));
            }
          });
          
          // Copy claude-hooks/ and scripts/ dirs (claude-commands/ removed —
          // slash commands now ship via claude-plugin/ only).
          for (const dir of ['claude-hooks', 'scripts']) {
            if (fs.existsSync(dir)) {
              const destDir = path.join('dist', dir);
              fs.mkdirSync(destDir, { recursive: true });
              for (const file of fs.readdirSync(dir)) {
                fs.copyFileSync(path.join(dir, file), path.join(destDir, file));
              }
            }
          }

          // Create optimized package.json
          const distPkg = {
            ...pkg,
            main: 'cli.js',
            bin: {
              ccrotate: './cli.js'
            },
            scripts: {
              postinstall: 'node scripts/postinstall.js'
            },
            files: ['*']
          };

          // Remove unnecessary fields for distribution
          delete distPkg.devDependencies;

          fs.writeFileSync('dist/package.json', JSON.stringify(distPkg, null, 2));
          
          console.log('\n✅ Build completed! Files copied to dist/');
          console.log('📦 Ready for publishing from dist/ directory');
        });
      }
    }
  ]
};

const buildProduction = () => build({
  ...baseConfig,
  minify: true
});

const buildDevelopment = () => build({
  ...baseConfig,
  sourcemap: true
});

export { buildProduction, buildDevelopment };