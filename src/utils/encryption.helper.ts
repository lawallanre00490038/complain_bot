import crypto from 'node:crypto';

export function decryptWhatsAppFlowData(
  encryptedData: string,
  encryptedAesKey: string,
  initialVector: string
) {

  const privateKey = process.env.WHATSAPP_PRIVATE_KEY!.replace(/\\n/g, '\n');

  // 1. Decrypt the AES key using your RSA Private Key
  const aesKey = crypto.privateDecrypt(
    {
      key: privateKey,
      padding: crypto.constants.RSA_PKCS1_OAEP_PADDING,
      oaepHash: 'sha256',
    },
    Buffer.from(encryptedAesKey, 'base64')
  );

  // 2. Decrypt the flow data using the decrypted AES key
  const decipher = crypto.createDecipheriv(
    'aes-128-gcm',
    aesKey,
    Buffer.from(initialVector, 'base64')
  );

  // Meta's GCM encryption usually includes an auth tag at the end
  // If you get 'Unsupported state' errors, you'll need to split the auth tag.
  let decrypted = decipher.update(encryptedData, 'base64', 'utf8');
  decrypted += decipher.final('utf8');

  return JSON.parse(decrypted);
}
