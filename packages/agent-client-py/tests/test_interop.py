"""The Python client and the browser's WebCrypto read each other's DMs."""
import json
import shutil
import subprocess
from pathlib import Path

import pytest

from babelr_agent import crypto

HERE = Path(__file__).parent
needs_node = pytest.mark.skipif(not shutil.which("node"), reason="needs node for WebCrypto")


def _node(script, payload):
    r = subprocess.run(["node", str(HERE / script)], input=json.dumps(payload),
                       capture_output=True, text=True, check=True)
    return json.loads(r.stdout), r.stderr


def test_roundtrip_in_python():
    a, b = crypto.generate_key(), crypto.generate_key()
    ka = crypto.shared_key(a, crypto.public_jwk(b))
    kb = crypto.shared_key(b, crypto.public_jwk(a))
    assert ka == kb and len(ka) == 32
    ct, iv = crypto.encrypt("hey cass, it's robokohl ⊖", ka)
    assert len(iv) == 16  # what the server's IV check expects
    assert crypto.decrypt(ct, iv, kb) == "hey cass, it's robokohl ⊖"


def test_fresh_iv_every_time():
    k = crypto.shared_key(crypto.generate_key(), crypto.public_jwk(crypto.generate_key()))
    assert crypto.encrypt("x", k)[1] != crypto.encrypt("x", k)[1]


@needs_node
def test_browser_to_agent_and_back():
    agent = crypto.generate_key()
    out, priv = _node("webcrypto.mjs", {"partnerJwk": crypto.public_jwk(agent), "plaintext": "from the browser"})
    browser_jwk = out["jwk"]
    key = crypto.shared_key(agent, browser_jwk)
    assert crypto.decrypt(out["ciphertext"], out["iv"], key) == "from the browser"

    ct, iv = crypto.encrypt("from the agent", key)
    back, _ = _node("webcrypto_decrypt.mjs", {"privJwk": json.loads(priv), "partnerJwk": crypto.public_jwk(agent),
                                               "ciphertext": ct, "iv": iv})
    assert back["plaintext"] == "from the agent"


def test_key_file_is_private_and_reused(tmp_path):
    p = tmp_path / "k" / "key.pem"
    k1 = crypto.load_or_create_key(p)
    assert oct(p.stat().st_mode & 0o777) == "0o600"
    k2 = crypto.load_or_create_key(p)
    assert crypto.public_jwk(k1) == crypto.public_jwk(k2)


def test_public_jwk_has_no_private_part():
    assert "d" not in crypto.public_jwk(crypto.generate_key())
