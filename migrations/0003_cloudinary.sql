-- 0003: 파일 스토리지를 Cloudinary로 교체 (KV 1GB → Cloudinary 무료 25GB)
-- storage_key: Cloudinary public_id, url: secure_url (CDN 직접 서빙)

ALTER TABLE files RENAME COLUMN r2_key TO storage_key;
ALTER TABLE files ADD COLUMN url TEXT;
ALTER TABLE files ADD COLUMN resource_type TEXT NOT NULL DEFAULT 'raw';
