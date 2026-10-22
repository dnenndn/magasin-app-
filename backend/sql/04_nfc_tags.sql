-- STEP 4 (NFC tags) - run in SSMS once. Only touches the small GMAO_APP
-- database; the original GMAO database is not changed. Safe to run twice.
--
-- One row per physical NFC tag: the tag's UID (printed in hex by the phone)
-- and the GMAO article it stands for. Several tags may point to the same
-- article (one per bin/shelf); a tag points to exactly one article.

USE GMAO_APP;
GO

IF OBJECT_ID('dbo.app_nfc_tag') IS NULL
BEGIN
    CREATE TABLE dbo.app_nfc_tag (
        uid        NVARCHAR(20) NOT NULL PRIMARY KEY,   -- upper-case hex, no separators
        id_article INT NOT NULL,                        -- GMAO article.id
        created_by INT NULL,                            -- GMAO utilisateur.id
        created_at DATETIME NOT NULL DEFAULT GETDATE()
    );
    CREATE INDEX IX_app_nfc_tag_article ON dbo.app_nfc_tag (id_article);
END;
GO
