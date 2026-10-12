-- STEP 3 of 3 - run in SSMS ONLY AFTER the new backend code is deployed,
-- running, and you have tested Valider / Historique / notifications once.
-- (The old backend code needs these objects; the new code does not.)
--
-- Removes what the mobile app had added to the ORIGINAL GMAO database:
--   * the three app_* tables (now living in GMAO_APP)
--   * the extra "validation" column on brm (the desktop app never had it)
--
-- >>> If your GMAO database is not called GMAO_NGES, replace it below
-- >>> (the USE line, and the safety check just under it).
--
-- NOT undone by this script (see the bottom): the UPDATE of bsm.validation
-- and the three performance indexes.

USE GMAO_NGES;
GO

-- Everything below is ONE batch on purpose: if the safety check fails, the
-- THROW aborts the batch and nothing after it runs (a GO between them would
-- let SSMS carry on and drop the tables anyway).
SET XACT_ABORT ON;

-- Safety check: refuse to drop anything unless the new database exists and
-- already holds at least as many pending requests as the original one.
IF OBJECT_ID('dbo.app_pending_request') IS NOT NULL AND DB_ID('GMAO_APP') IS NULL
    THROW 50002, 'GMAO_APP does not exist yet. Run 01 and 02 first. Nothing was dropped.', 1;

IF OBJECT_ID('dbo.app_pending_request') IS NOT NULL
   AND (SELECT COUNT(*) FROM dbo.app_pending_request) > (SELECT COUNT(*) FROM GMAO_APP.dbo.app_pending_request)
    THROW 50001, 'GMAO_APP has fewer pending requests than the original database. Run 02_copy_existing_data.sql first. Nothing was dropped.', 1;

IF OBJECT_ID('dbo.app_pending_request') IS NOT NULL DROP TABLE dbo.app_pending_request;
IF OBJECT_ID('dbo.app_device_token') IS NOT NULL DROP TABLE dbo.app_device_token;
IF OBJECT_ID('dbo.app_notification_log') IS NOT NULL DROP TABLE dbo.app_notification_log;

-- brm.validation was added with a DEFAULT constraint (system-named), which
-- has to be dropped before the column can be.
DECLARE @df sysname = (
    SELECT dc.name
    FROM sys.default_constraints dc
    JOIN sys.columns c ON c.object_id = dc.parent_object_id AND c.column_id = dc.parent_column_id
    WHERE dc.parent_object_id = OBJECT_ID('dbo.brm') AND c.name = 'validation'
);
-- (EXEC('...' + QUOTENAME(...)) is not valid T-SQL: build the text first.)
DECLARE @sql nvarchar(400) = N'ALTER TABLE dbo.brm DROP CONSTRAINT ' + QUOTENAME(@df);
IF @df IS NOT NULL EXEC (@sql);
IF EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID('dbo.brm') AND name = 'validation')
    ALTER TABLE dbo.brm DROP COLUMN validation;

PRINT 'Done: app_* tables and brm.validation removed from the original database.';
GO

-- ---------------------------------------------------------------------------
-- OPTIONAL: the three indexes added earlier to speed up the Valider /
-- Historique screens. They are harmless to the desktop app and make those
-- screens faster, so they are left in place. Uncomment to remove them too.
-- ---------------------------------------------------------------------------
-- IF EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_bsm_createur' AND object_id = OBJECT_ID('dbo.bsm')) DROP INDEX IX_bsm_createur ON dbo.bsm;
-- IF EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_bsm_id_receptionniste' AND object_id = OBJECT_ID('dbo.bsm')) DROP INDEX IX_bsm_id_receptionniste ON dbo.bsm;
-- IF EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_brm_retour_par' AND object_id = OBJECT_ID('dbo.brm')) DROP INDEX IX_brm_retour_par ON dbo.brm;

-- ---------------------------------------------------------------------------
-- NOT reversible by script: the old migration ran
--     UPDATE bsm SET validation = 'Oui' WHERE validation <> 'Oui' OR validation IS NULL;
-- which overwrote the previous values, and nothing recorded what they were.
-- The new backend no longer reads bsm.validation, so it does no harm. If you
-- need the old values back, restore them from a database backup taken before
-- that migration was run.
-- ---------------------------------------------------------------------------
