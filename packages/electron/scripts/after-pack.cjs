const fs = require('node:fs');
const path = require('node:path');
const { execSync } = require('node:child_process');

const BUNDLE_LIBS = [
  { name: 'libz.so.1', pkg: 'zlib1g', searchPaths: ['/usr/lib', '/lib'] },
];

const locateSystemLibrary = (libName, searchPaths) => {
  for (const dir of searchPaths) {
    // Try the exact name first
    const exact = path.join(dir, libName);
    if (fs.existsSync(exact)) return exact;

    // Try arch-specific subdirs
    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory() && entry.name.includes('linux-gnu')) {
          const archPath = path.join(dir, entry.name, libName);
          if (fs.existsSync(archPath)) return archPath;
        }
      }
    } catch { /* dir may not exist */ }
  }
  return null;
};

module.exports = (context) => {
  if (context.electronPlatformName === 'darwin') {
    const appName = context.packager.appInfo.productFilename;
    const appBundlePath = path.join(context.appOutDir, `${appName}.app`);
    const resourcesPath = path.join(appBundlePath, 'Contents', 'Resources');
    const sourceAssetsPath = path.join(__dirname, '..', 'resources', 'icons', 'Assets.car');

    if (!fs.existsSync(sourceAssetsPath)) {
      throw new Error(`Missing compiled app icon asset catalog at ${sourceAssetsPath}`);
    }

    fs.copyFileSync(sourceAssetsPath, path.join(resourcesPath, 'Assets.car'));
  }

  if (context.electronPlatformName === 'linux') {
    const executableName = context.packager.appInfo.productFilename;
    const electronBinary = path.join(context.appOutDir, executableName);

    if (!fs.existsSync(electronBinary)) {
      console.warn(`after-pack: Electron binary not found at ${electronBinary}, skipping library bundling`);
      return;
    }

    // Create lib directory next to the binary
    const libDir = path.join(context.appOutDir, 'lib');
    fs.mkdirSync(libDir, { recursive: true });

    for (const lib of BUNDLE_LIBS) {
      const src = locateSystemLibrary(lib.name, lib.searchPaths);
      if (!src) {
        console.warn(`after-pack: ${lib.name} not found on build host, skipping (install ${lib.pkg})`);
        continue;
      }

      const dest = path.join(libDir, lib.name);
      fs.copyFileSync(src, dest);
      console.log(`after-pack: bundled ${src} → ${dest}`);

      // Resolve symlinks and copy the real file
      const realPath = fs.realpathSync(src);
      if (realPath !== src) {
        fs.copyFileSync(realPath, dest);
        console.log(`after-pack: resolved symlink, bundled ${realPath}`);
      }
    }

    // Set RPATH so the bundled Electron looks in ./lib/ first.
    // Preserve any existing RPATH to avoid breaking Electron's own library resolution.
    try {
      let existingRpath = '';
      try {
        existingRpath = execSync(`patchelf --print-rpath '${electronBinary}'`, {
          stdio: 'pipe',
          timeout: 5000,
        }).toString().trim();
      } catch {
        // Binary may have no RPATH set — that's fine
      }

      const newRpath = existingRpath
        ? `$ORIGIN/lib:${existingRpath}`
        : '$ORIGIN/lib';

      execSync(`patchelf --set-rpath '${newRpath}' '${electronBinary}'`, {
        stdio: 'pipe',
        timeout: 10000,
      });
      console.log(`after-pack: set RPATH="${newRpath}" on ${electronBinary}`);
    } catch (err) {
      console.warn(`after-pack: patchelf failed (${err.message}), library bundling may not work offline`);
    }
  }
};
