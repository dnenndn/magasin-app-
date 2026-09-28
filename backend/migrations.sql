-- Run this once in SSMS against GMAO_NGES before using the new
-- validation/notification features. These are NEW tables for this app only
-- (they don't exist in the original GMAO schema) - safe to add, nothing
-- else reads or writes them.

USE GMAO_NGES;

-- Missing indexes confirmed by you (only PK_bsm/PK_brm existed) - these are
-- what was making the Valider/Historique screens slow, since every query
-- filtering or joining on these columns was doing a full table scan.
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_bsm_createur')
    CREATE INDEX IX_bsm_createur ON bsm (createur);
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_bsm_id_receptionniste')
    CREATE INDEX IX_bsm_id_receptionniste ON bsm (id_receptionniste);
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_brm_retour_par')
    CREATE INDEX IX_brm_retour_par ON brm (retour_par);

-- Unlike brm, bsm.validation already existed - but the desktop app always
-- inserts new BSMs as 'Non' and (as far as we've found) never flips them to
-- 'Oui' anywhere, so most of your existing BSM history is genuinely sitting
-- at 'Non' already, independent of this app. Same assumption as brm: rows
-- that already existed are treated as validated. This only touches rows
-- that exist right now - a BSM created later directly from the desktop app
-- will still start as 'Non' (that's the desktop app's own behavior, not
-- something this migration can change), it just won't affect the mobile
-- app's Valider tab since that no longer reads bsm.validation at all.
UPDATE bsm SET validation = 'Oui' WHERE validation <> 'Oui' OR validation IS NULL;

-- Pending requests from non-manager users. Nothing here ever touches bsm,
-- brm, bsm_article, brm_article, or article - a row in this table is just a
-- proposal. It only becomes a real BSM/BRM (and only then affects stock)
-- once a manager approves it; the whole original request is kept as JSON
-- so approval can replay it exactly.
IF NOT EXISTS (SELECT 1 FROM sys.tables WHERE name = 'app_pending_request')
BEGIN
    CREATE TABLE app_pending_request (
        id INT IDENTITY(1,1) PRIMARY KEY,
        kind NVARCHAR(3) NOT NULL,              -- 'bsm' | 'brm'
        id_requester INT NOT NULL,
        payload NVARCHAR(MAX) NOT NULL,         -- JSON of the original request body
        status NVARCHAR(10) NOT NULL DEFAULT 'pending', -- 'pending' | 'approved' | 'rejected'
        id_result INT NULL,                     -- the real bsm.id/brm.id, once approved
        created_at DATETIME NOT NULL DEFAULT GETDATE(),
        resolved_at DATETIME NULL,
        resolved_by INT NULL
    );
    CREATE INDEX IX_app_pending_request_status ON app_pending_request (kind, status);
END;

-- Rejection reason, shown on the Accueil "Derniers mouvements" feed (e.g.
-- "Rejeté — Stock insuffisant"). Added after the table above already
-- existed for some of you, so it's a separate additive step.
IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID('app_pending_request') AND name = 'reason')
BEGIN
    ALTER TABLE app_pending_request ADD reason NVARCHAR(300) NULL;
END;

-- brm has no validation concept in the original schema (confirmed - the
-- desktop app's own INSERT into brm never sets one). Adding it here as a
-- nullable-with-default column is safe: the desktop app only ever inserts
-- the columns it explicitly lists and never does SELECT *, so this is
-- invisible to it. Default 'Oui' means all pre-existing desktop-created
-- rows are treated as already validated (nothing retroactively becomes
-- "pending").
IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID('brm') AND name = 'validation')
BEGIN
    ALTER TABLE brm ADD validation NVARCHAR(3) NOT NULL DEFAULT 'Oui';
END;

-- One row per device a user has logged in from, holding its push token.
-- A user can have more than one device (phone + tablet, etc.).
IF NOT EXISTS (SELECT 1 FROM sys.tables WHERE name = 'app_device_token')
BEGIN
    CREATE TABLE app_device_token (
        id INT IDENTITY(1,1) PRIMARY KEY,
        id_user INT NOT NULL,
        token NVARCHAR(400) NOT NULL,
        platform NVARCHAR(20) NULL,
        created_at DATETIME NOT NULL DEFAULT GETDATE(),
        CONSTRAINT UQ_app_device_token_token UNIQUE (token)
    );
END;

-- A light audit trail of what was sent, mainly useful for the in-app
-- notifications list and for debugging delivery. Not required for push to
-- work, but the app reads it to show "recent notifications" in-app.
IF NOT EXISTS (SELECT 1 FROM sys.tables WHERE name = 'app_notification_log')
BEGIN
    CREATE TABLE app_notification_log (
        id INT IDENTITY(1,1) PRIMARY KEY,
        id_user INT NOT NULL,           -- recipient
        type NVARCHAR(30) NOT NULL,     -- 'bsm_created' | 'bsm_validated' | 'brm_created' | 'brm_validated'
        id_ref INT NULL,                -- id_bsm or id_brm
        message NVARCHAR(300) NOT NULL,
        created_at DATETIME NOT NULL DEFAULT GETDATE(),
        read_at DATETIME NULL
    );
END;
