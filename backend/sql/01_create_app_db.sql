-- STEP 1 of 3 - run in SSMS (needs a login allowed to CREATE DATABASE).
--
-- Creates a small separate database for everything the mobile app needs that
-- is NOT part of the GMAO schema: pending BSM/BRM requests awaiting manager
-- validation, device push tokens, and the in-app notification log.
-- The original GMAO database is not touched by this script.
--
-- Safe to run more than once.

IF DB_ID('GMAO_APP') IS NULL
    CREATE DATABASE GMAO_APP;
GO

USE GMAO_APP;
GO

-- Pending requests from non-manager users. A row here is only a proposal:
-- it becomes a real BSM/BRM in the GMAO database (and only then affects
-- stock) once a manager approves it. The whole original request is kept as
-- JSON so approval can replay it exactly.
IF OBJECT_ID('dbo.app_pending_request') IS NULL
BEGIN
    CREATE TABLE dbo.app_pending_request (
        id INT IDENTITY(1,1) PRIMARY KEY,
        kind NVARCHAR(3) NOT NULL,                         -- 'bsm' | 'brm'
        id_requester INT NOT NULL,                         -- GMAO utilisateur.id
        payload NVARCHAR(MAX) NOT NULL,                    -- JSON of the original request body
        status NVARCHAR(10) NOT NULL DEFAULT 'pending',    -- 'pending' | 'approving' | 'approved' | 'rejected'
        id_result INT NULL,                                -- the real bsm.id/brm.id, once approved
        created_at DATETIME NOT NULL DEFAULT GETDATE(),
        resolved_at DATETIME NULL,
        resolved_by INT NULL,                              -- GMAO utilisateur.id of the approver/rejecter
        reason NVARCHAR(300) NULL                          -- rejection reason
    );
    CREATE INDEX IX_app_pending_request_status ON dbo.app_pending_request (kind, status);
    CREATE INDEX IX_app_pending_request_requester ON dbo.app_pending_request (id_requester, status);
    CREATE INDEX IX_app_pending_request_result ON dbo.app_pending_request (kind, id_result);
END;
GO

-- One row per device a user has logged in from, holding its push token.
IF OBJECT_ID('dbo.app_device_token') IS NULL
BEGIN
    CREATE TABLE dbo.app_device_token (
        id INT IDENTITY(1,1) PRIMARY KEY,
        id_user INT NOT NULL,
        token NVARCHAR(400) NOT NULL,
        platform NVARCHAR(20) NULL,
        created_at DATETIME NOT NULL DEFAULT GETDATE(),
        CONSTRAINT UQ_app_device_token_token UNIQUE (token)
    );
    CREATE INDEX IX_app_device_token_user ON dbo.app_device_token (id_user);
END;
GO

-- Audit trail of what was sent; powers the in-app notifications list.
IF OBJECT_ID('dbo.app_notification_log') IS NULL
BEGIN
    CREATE TABLE dbo.app_notification_log (
        id INT IDENTITY(1,1) PRIMARY KEY,
        id_user INT NOT NULL,
        type NVARCHAR(30) NOT NULL,
        id_ref INT NULL,
        message NVARCHAR(300) NOT NULL,
        created_at DATETIME NOT NULL DEFAULT GETDATE(),
        read_at DATETIME NULL
    );
    CREATE INDEX IX_app_notification_log_user ON dbo.app_notification_log (id_user, read_at);
END;
GO
