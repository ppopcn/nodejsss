const crypto = require('crypto');

class AEADCrypto {
  constructor(password, method = 'aes-256-gcm') {
    this.password = password;
    this.method = method;
    this.keyLen = this.getKeyLen(method);
    this.saltLen = this.getSaltLen(method);
    this.tagLen = 16;
    this.mainKey = this.deriveMainKey(password, this.keyLen);
  }

  getKeyLen(method) {
    if (method === 'aes-256-gcm' || method === 'chacha20-ietf-poly1305') return 32;
    if (method === 'aes-128-gcm') return 16;
    return 32;
  }

  getSaltLen(method) {
    if (method === 'aes-256-gcm' || method === 'aes-128-gcm') return this.getKeyLen(method);
    if (method === 'chacha20-ietf-poly1305') return 32;
    return 32;
  }

  deriveMainKey(password, keyLen) {
    let key = Buffer.alloc(keyLen);
    let hash = Buffer.alloc(0);
    let pos = 0;
    while (pos < keyLen) {
      const md5 = crypto.createHash('md5');
      md5.update(hash);
      md5.update(password, 'utf8');
      hash = md5.digest();
      const copyLen = Math.min(hash.length, keyLen - pos);
      hash.copy(key, pos, 0, copyLen);
      pos += copyLen;
    }
    return key;
  }

  // SIP008 HKDF Key Derivation
  deriveSubkey(salt) {
    return crypto.hkdfSync('sha1', this.mainKey, salt, 'ss-subkey', this.keyLen);
  }

  static incrementNonce(nonce) {
    for (let i = 0; i < nonce.length; i++) {
      nonce[i]++;
      if (nonce[i] !== 0) break;
    }
  }
}

class AEADEncryptor extends AEADCrypto {
  constructor(password, method) {
    super(password, method);
    this.salt = crypto.randomBytes(this.saltLen);
    this.subkey = this.deriveSubkey(this.salt);
    this.nonce = Buffer.alloc(12, 0); // GCM standard nonce size is 12
    this.saltSent = false;
  }

  encryptChunk(data) {
    const chunks = [];
    if (!this.saltSent) {
      chunks.push(this.salt);
      this.saltSent = true;
    }

    // 1. Encrypt length (2 bytes)
    const lenBuf = Buffer.alloc(2);
    lenBuf.writeUInt16BE(data.length);
    const cipherLen = crypto.createCipheriv(this.method, this.subkey, this.nonce, { authTagLength: this.tagLen });
    const encLen = cipherLen.update(lenBuf);
    cipherLen.final();
    const tagLen = cipherLen.getAuthTag();
    chunks.push(encLen, tagLen);
    AEADCrypto.incrementNonce(this.nonce);

    // 2. Encrypt payload
    const cipherPayload = crypto.createCipheriv(this.method, this.subkey, this.nonce, { authTagLength: this.tagLen });
    const encPayload = cipherPayload.update(data);
    cipherPayload.final();
    const tagPayload = cipherPayload.getAuthTag();
    chunks.push(encPayload, tagPayload);
    AEADCrypto.incrementNonce(this.nonce);

    return Buffer.concat(chunks);
  }
}

class AEADDecryptor extends AEADCrypto {
  constructor(password, method) {
    super(password, method);
    this.salt = null;
    this.subkey = null;
    this.nonce = Buffer.alloc(12, 0);
    this.buffer = Buffer.alloc(0);
    this.stage = 'SALT'; // SALT -> LEN -> PAYLOAD
    this.payloadLen = 0;
  }

  decrypt(data) {
    this.buffer = Buffer.concat([this.buffer, data]);
    const results = [];

    while (true) {
      if (this.stage === 'SALT') {
        if (this.buffer.length < this.saltLen) break;
        this.salt = this.buffer.slice(0, this.saltLen);
        this.buffer = this.buffer.slice(this.saltLen);
        this.subkey = this.deriveSubkey(this.salt);
        this.stage = 'LEN';
      } else if (this.stage === 'LEN') {
        const required = 2 + this.tagLen;
        if (this.buffer.length < required) break;
        
        const encLen = this.buffer.slice(0, 2);
        const tag = this.buffer.slice(2, required);
        this.buffer = this.buffer.slice(required);

        const decipher = crypto.createDecipheriv(this.method, this.subkey, this.nonce, { authTagLength: this.tagLen });
        decipher.setAuthTag(tag);
        const lenBuf = decipher.update(encLen);
        try {
          decipher.final();
          this.payloadLen = lenBuf.readUInt16BE(0);
          this.stage = 'PAYLOAD';
          AEADCrypto.incrementNonce(this.nonce);
        } catch (e) {
          throw new Error('Failed to decrypt chunk length');
        }
      } else if (this.stage === 'PAYLOAD') {
        const required = this.payloadLen + this.tagLen;
        if (this.buffer.length < required) break;

        const encPayload = this.buffer.slice(0, this.payloadLen);
        const tag = this.buffer.slice(this.payloadLen, required);
        this.buffer = this.buffer.slice(required);

        const decipher = crypto.createDecipheriv(this.method, this.subkey, this.nonce, { authTagLength: this.tagLen });
        decipher.setAuthTag(tag);
        const payload = decipher.update(encPayload);
        try {
          decipher.final();
          results.push(payload);
          this.stage = 'LEN';
          AEADCrypto.incrementNonce(this.nonce);
        } catch (e) {
          throw new Error('Failed to decrypt payload');
        }
      }
    }
    return Buffer.concat(results);
  }
}

module.exports = {
  AEADEncryptor,
  AEADDecryptor
};
