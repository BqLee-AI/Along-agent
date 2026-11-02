"""Behavioral contract checks; no model download or business dependencies."""

import hashlib
import tempfile
from pathlib import Path
import unittest
from concurrent.futures import Future
from unittest.mock import patch

import numpy as np
from pydantic import ValidationError

from service import EncodeRequest, Encoder, Refusal, normalized, unit_cls
from manifest import verify_assets


class EncodingContractTests(unittest.TestCase):
    def test_asset_hash_and_size_are_enforced(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "asset"
            path.write_bytes(b"fixed")
            expected = {"asset": (5, hashlib.sha256(b"fixed").hexdigest())}
            with patch("manifest.ASSETS", expected):
                verify_assets(folder)
                path.write_bytes(b"other")
                with self.assertRaisesRegex(ValueError, "hash/size mismatch"):
                    verify_assets(folder)
                path.write_bytes(b"too long")
                with self.assertRaisesRegex(ValueError, "hash/size mismatch"):
                    verify_assets(folder)
                path.write_bytes(b"fixed")
                (Path(folder) / "added_tokens.json").write_text("{}")
                with self.assertRaisesRegex(ValueError, "Unmanifested asset"):
                    verify_assets(folder)

    def test_strict_single_text_contract(self):
        valid = {"binding_sha256": "a" * 64, "text": "原话", "max_tokens": 256, "truncate": False}
        self.assertEqual(EncodeRequest(**valid).text, "原话")
        for change in ({"model": "other"}, {"text": ["a", "b"]}, {"max_tokens": 257},
                       {"max_tokens": 256.0}, {"truncate": 0}, {"truncate": True}, {"binding_sha256": "A" * 64}):
            with self.subTest(change=change), self.assertRaises(ValidationError):
                EncodeRequest(**(valid | change))

    def test_normalization_preserves_meaning_and_ecmascript_boundaries(self):
        self.assertEqual(normalized("\ufeff e\u0301\r\n不取消 \u3000"), "é\n不取消")
        self.assertEqual(normalized("\u0085x\u0085"), "\u0085x\u0085")
        self.assertEqual(normalized("\u001cx\u001c"), "\u001cx\u001c")
        self.assertEqual(normalized(normalized(" e\u0301\r\n ")), normalized(" e\u0301\r\n "))

    def test_cls_dimension_nonfinite_zero_and_l2(self):
        hidden = np.zeros((1, 3, 512), dtype=np.float32)
        hidden[0, 0, :2] = [3, 4]
        hidden[0, 1:, :] = 100
        vector = unit_cls(hidden, 3)
        np.testing.assert_allclose(vector[:2], [0.6, 0.8], atol=1e-7)
        self.assertEqual(len(vector), 512)
        for broken in (np.zeros((1, 3, 511)), np.zeros((1, 3, 512)),
                       np.full((1, 3, 512), np.nan), np.full((1, 3, 512), np.inf)):
            with self.assertRaises(ValueError):
                unit_cls(broken, 3)

    def test_exact_token_limit_never_forwards_overflow(self):
        import threading
        from unittest.mock import Mock
        encoder = Encoder.__new__(Encoder)
        encoder.lock = threading.Lock()
        encoder.forwards = 0
        encoder.binding = "a" * 64
        encoder.session = Mock()
        for count in (257, 500):
            encoder.tokenizer = Mock(return_value={"input_ids": np.zeros((1, count), dtype=np.int64)})
            with self.assertRaises(Refusal) as refusal:
                encoder.encode("完整输入")
            self.assertEqual(refusal.exception.details["token_count"], count)
            encoder.session.run.assert_not_called()
            self.assertEqual(encoder.forwards, 0)
            self.assertFalse(encoder.tokenizer.call_args.kwargs["truncation"])

    def test_capacity_released_only_by_real_completion(self):
        # The worker future is deliberately still running after an HTTP awaiter leaves.
        import threading
        encoder = Encoder.__new__(Encoder)
        encoder.lock = threading.Lock()
        encoder.inflight = encoder.high_water = encoder.completed = 0
        first, second = Future(), Future()
        first.set_running_or_notify_cancel()
        second.set_running_or_notify_cancel()
        encoder.encode = lambda text: text
        with patch.object(encoder, "pool", create=True) as pool:
            pool.submit.side_effect = [first, second]
            self.assertIs(encoder.submit("one"), first)
            self.assertIs(encoder.submit("two"), second)
            self.assertFalse(first.cancel())
            with self.assertRaises(Refusal) as refusal:
                encoder.submit("three")
            self.assertEqual(refusal.exception.code, "CAPACITY")
            self.assertEqual(encoder.inflight, 2)
            first.set_result("one")
            self.assertEqual(encoder.inflight, 1)
            second.set_exception(RuntimeError("compute failed"))
            self.assertEqual(encoder.inflight, 0)
            self.assertEqual(encoder.completed, 2)


if __name__ == "__main__":
    unittest.main()
