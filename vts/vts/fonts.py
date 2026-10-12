"""App-local font imports and cross-platform installed-font discovery.

No OS installation, registry writes or arbitrary-path HTTP serving. Imported
TTF/OTF files persist in work/fonts and are available to browsers and libass.
"""
from __future__ import annotations

import hashlib
import os
import shutil
from pathlib import Path
from threading import RLock

from fontTools.ttLib import TTFont

MAX_FONT_BYTES = 20 * 1024 * 1024


class FontLibrary:
    def __init__(self, directory: Path):
        self.directory = directory
        self.records: dict[str, dict] = {}
        self.lock = RLock()
        self.scanned = False

    def _record(self, path: Path, imported=False) -> dict:
        with TTFont(path, lazy=True) as font:
            names = font['name']
            family = names.getBestFamilyName() or names.getDebugName(1)
            if not family:
                raise ValueError('Font has no family name.')
            style = names.getBestSubFamilyName() or 'Regular'
            weight = int(font['OS/2'].usWeightClass) if 'OS/2' in font else 400
            italic = bool(font['head'].macStyle & 2)
        key = hashlib.sha256(str(path.resolve()).encode()).hexdigest()[:24]
        record = dict(id=key, family=family, style=style, weight=weight,
                      italic=italic, imported=imported, path=str(path))
        self.records[key] = record
        return record

    def scan(self, refresh=False) -> list[dict]:
        with self.lock:
            if not self.scanned or refresh:
                home = Path.home()
                roots = [self.directory, Path(os.environ.get('WINDIR', 'C:/Windows')) / 'Fonts',
                         home / 'AppData/Local/Microsoft/Windows/Fonts',
                         Path('/usr/share/fonts'), Path('/usr/local/share/fonts'),
                         home / '.fonts', home / '.local/share/fonts',
                         Path('/System/Library/Fonts'), Path('/Library/Fonts'), home / 'Library/Fonts']
                for root in roots:
                    if not root.is_dir():
                        continue
                    for path in root.rglob('*'):
                        if path.suffix.lower() not in ('.ttf', '.otf'):
                            continue
                        try:
                            self._record(path, root == self.directory)
                        except Exception:
                            # Broken/unsupported system fonts must not hide the rest.
                            continue
                self.scanned = True
            return [{k: v for k, v in r.items() if k != 'path'}
                    for r in sorted(self.records.values(), key=lambda r: (r['family'].casefold(), r['style']))]

    def import_font(self, data: bytes, filename: str) -> dict:
        suffix = Path(filename).suffix.lower()
        if suffix not in ('.ttf', '.otf'):
            raise ValueError('Import a .ttf or .otf font.')
        if not data or len(data) > MAX_FONT_BYTES:
            raise ValueError('Fonts must be between 1 byte and 20 MB.')
        self.directory.mkdir(parents=True, exist_ok=True)
        path = self.directory / (hashlib.sha256(data).hexdigest() + suffix)
        with self.lock:
            existed = path.exists()
            if not existed:
                path.write_bytes(data)
            try:
                record = self._record(path, True)
                return {k: v for k, v in record.items() if k != 'path'}
            except Exception as exc:
                if not existed:
                    path.unlink(missing_ok=True)
                raise ValueError('Not a valid supported font.') from exc

    def export_directory(self, families: set[str]) -> str:
        """Make selected installed faces explicit to libass, also on Windows."""
        self.scan()
        self.directory.mkdir(parents=True, exist_ok=True)
        with self.lock:
            for r in list(self.records.values()):
                if r['family'] in families:
                    source = Path(r['path'])
                    if source.parent != self.directory:
                        dest = self.directory / (r['id'] + source.suffix.lower())
                        if not dest.exists():
                            shutil.copyfile(source, dest)
        return str(self.directory)
