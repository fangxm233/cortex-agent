"""Pure boundary tests: never start a product process."""
import io
from pathlib import Path
import tarfile
import tempfile
import unittest

from inputs import extract_package, audit_links


class InputTests(unittest.TestCase):
    def archive(self, root, name, kind=tarfile.REGTYPE, link=''):
        path = root / 'server.tgz'
        with tarfile.open(path, 'w:gz') as archive:
            entry = tarfile.TarInfo(name)
            entry.type, entry.linkname = kind, link
            archive.addfile(entry, io.BytesIO(b''))
        return path

    def test_rejects_archive_escape(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            for name in ('../escape', '/escape', 'package/../../escape'):
                with self.assertRaises(ValueError):
                    extract_package(self.archive(root, name), root / 'out')

    def test_rejects_archive_links_and_devices(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            for kind in (tarfile.SYMTYPE, tarfile.LNKTYPE, tarfile.CHRTYPE):
                with self.assertRaises(ValueError):
                    extract_package(self.archive(root, 'package/a', kind, '/etc'), root / 'out')

    def test_allows_regular_package(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            extract_package(self.archive(root, 'package/package.json'), root / 'out')
            self.assertTrue((root / 'out/package/package.json').is_file())

    def test_external_symlink_fails_closed(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            deps = root / 'deps'
            deps.mkdir()
            (deps / 'bad').symlink_to('/etc/passwd')
            with self.assertRaises(ValueError):
                audit_links([deps])

    def test_internal_and_explicit_exact_dependency_roots(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            deps, extra = root / 'deps', root / 'package-extra'
            deps.mkdir()
            extra.mkdir()
            (extra / 'package.json').write_text('{}')
            (deps / 'extra').symlink_to(extra)
            self.assertEqual(audit_links([deps, extra]), 1)


if __name__ == '__main__':
    unittest.main()
