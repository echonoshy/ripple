use serde_json::{json, Value};
use sqlx::Row;
use uuid::Uuid;

use super::{json_from_text, json_text, Storage};

impl Storage {
    pub async fn create_direct_conversation(
        &self,
        requester_user_id: &str,
        contact_user_id: &str,
    ) -> anyhow::Result<Value> {
        self.initialize().await?;
        let direct_key = direct_conversation_key(requester_user_id, contact_user_id);
        if let Some(existing) = self.get_direct_conversation_by_key(&direct_key).await? {
            return Ok(existing);
        }

        let now = conversation_now_iso();
        let conversation_id = format!("conv-{}", &Uuid::new_v4().simple().to_string()[..10]);
        let participants =
            direct_participants(&conversation_id, requester_user_id, contact_user_id, &now);
        let record = json!({
            "conversation_id": conversation_id,
            "kind": "direct",
            "direct_key": direct_key,
            "title": null,
            "created_by_user_id": requester_user_id,
            "created_at": now,
            "updated_at": now,
            "last_message_at": null,
            "participants": participants
        });

        let mut tx = self.pool.begin().await?;
        sqlx::query(
            r#"
            INSERT INTO conversations (
                conversation_id, kind, direct_key, title, created_by_user_id,
                created_at, updated_at, last_message_at, record_json
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            "#,
        )
        .bind(record.get("conversation_id").and_then(Value::as_str))
        .bind("direct")
        .bind(record.get("direct_key").and_then(Value::as_str))
        .bind(record.get("title").and_then(Value::as_str))
        .bind(requester_user_id)
        .bind(record.get("created_at").and_then(Value::as_str))
        .bind(record.get("updated_at").and_then(Value::as_str))
        .bind(record.get("last_message_at").and_then(Value::as_str))
        .bind(json_text(&record)?)
        .execute(&mut *tx)
        .await?;

        for participant in participants.iter().filter_map(Value::as_object) {
            sqlx::query(
                r#"
                INSERT INTO conversation_participants (
                    conversation_id, actor_type, actor_id, user_id, role, status,
                    last_read_message_seq, created_at, updated_at, record_json
                )
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                "#,
            )
            .bind(participant.get("conversation_id").and_then(Value::as_str))
            .bind(participant.get("actor_type").and_then(Value::as_str))
            .bind(participant.get("actor_id").and_then(Value::as_str))
            .bind(participant.get("user_id").and_then(Value::as_str))
            .bind(participant.get("role").and_then(Value::as_str))
            .bind(participant.get("status").and_then(Value::as_str))
            .bind(
                participant
                    .get("last_read_message_seq")
                    .and_then(Value::as_i64)
                    .unwrap_or(0),
            )
            .bind(participant.get("created_at").and_then(Value::as_str))
            .bind(participant.get("updated_at").and_then(Value::as_str))
            .bind(json_text(&Value::Object(participant.clone()))?)
            .execute(&mut *tx)
            .await?;
        }
        tx.commit().await?;
        Ok(record)
    }

    pub async fn list_conversations_for_user(&self, user_id: &str) -> anyhow::Result<Vec<Value>> {
        self.initialize().await?;
        let rows = sqlx::query(
            r#"
            SELECT c.record_json FROM conversations c
            INNER JOIN conversation_participants p
                ON p.conversation_id = c.conversation_id
            WHERE p.user_id = ? AND p.status = 'active'
            ORDER BY c.updated_at DESC, c.conversation_id ASC
            "#,
        )
        .bind(user_id)
        .fetch_all(&self.pool)
        .await?;
        rows.into_iter()
            .map(|row| json_from_text(row.get::<String, _>("record_json").as_str()))
            .collect()
    }

    pub async fn get_conversation_for_user(
        &self,
        user_id: &str,
        conversation_id: &str,
    ) -> anyhow::Result<Option<Value>> {
        self.initialize().await?;
        if !self
            .conversation_has_participant(conversation_id, user_id)
            .await?
        {
            return Ok(None);
        }
        self.get_conversation(conversation_id).await
    }

    pub async fn append_conversation_message(
        &self,
        conversation_id: &str,
        sender_user_id: &str,
        sender_actor_type: &str,
        sender_actor_id: &str,
        kind: &str,
        body: &Value,
    ) -> anyhow::Result<Value> {
        self.initialize().await?;
        if !self
            .conversation_has_participant(conversation_id, sender_user_id)
            .await?
        {
            anyhow::bail!("conversation not found for user");
        }
        let row = sqlx::query(
            r#"
            SELECT COALESCE(MAX(seq), 0) + 1 AS next_seq
            FROM conversation_messages
            WHERE conversation_id = ?
            "#,
        )
        .bind(conversation_id)
        .fetch_one(&self.pool)
        .await?;
        let seq = row.get::<i64, _>("next_seq");
        let now = conversation_now_iso();
        let message_id = format!("cmsg-{}", &Uuid::new_v4().simple().to_string()[..10]);
        let record = json!({
            "conversation_id": conversation_id,
            "seq": seq,
            "message_id": message_id,
            "sender_user_id": sender_user_id,
            "sender_actor_type": sender_actor_type,
            "sender_actor_id": sender_actor_id,
            "kind": kind,
            "body": body,
            "created_at": now
        });
        sqlx::query(
            r#"
            INSERT INTO conversation_messages (
                conversation_id, seq, message_id, sender_user_id, sender_actor_type,
                sender_actor_id, kind, created_at, record_json
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            "#,
        )
        .bind(conversation_id)
        .bind(seq)
        .bind(record.get("message_id").and_then(Value::as_str))
        .bind(sender_user_id)
        .bind(sender_actor_type)
        .bind(sender_actor_id)
        .bind(kind)
        .bind(record.get("created_at").and_then(Value::as_str))
        .bind(json_text(&record)?)
        .execute(&self.pool)
        .await?;
        self.touch_conversation_after_message(conversation_id, &now)
            .await?;
        Ok(record)
    }

    pub async fn list_conversation_messages_for_user(
        &self,
        user_id: &str,
        conversation_id: &str,
    ) -> anyhow::Result<Vec<Value>> {
        self.list_conversation_messages_for_user_after(user_id, conversation_id, 0)
            .await
    }

    pub async fn list_conversation_messages_for_user_after(
        &self,
        user_id: &str,
        conversation_id: &str,
        after_seq: i64,
    ) -> anyhow::Result<Vec<Value>> {
        self.initialize().await?;
        if !self
            .conversation_has_participant(conversation_id, user_id)
            .await?
        {
            return Ok(Vec::new());
        }
        let rows = sqlx::query(
            r#"
            SELECT record_json FROM conversation_messages
            WHERE conversation_id = ? AND seq > ?
            ORDER BY seq ASC
            "#,
        )
        .bind(conversation_id)
        .bind(after_seq.max(0))
        .fetch_all(&self.pool)
        .await?;
        rows.into_iter()
            .map(|row| json_from_text(row.get::<String, _>("record_json").as_str()))
            .collect()
    }

    pub async fn latest_conversation_message_seq(
        &self,
        conversation_id: &str,
    ) -> anyhow::Result<i64> {
        self.initialize().await?;
        let row = sqlx::query(
            r#"
            SELECT COALESCE(MAX(seq), 0) AS latest_seq
            FROM conversation_messages
            WHERE conversation_id = ?
            "#,
        )
        .bind(conversation_id)
        .fetch_one(&self.pool)
        .await?;
        Ok(row.get::<i64, _>("latest_seq"))
    }

    pub async fn mark_conversation_read(
        &self,
        user_id: &str,
        conversation_id: &str,
        last_read_message_seq: i64,
    ) -> anyhow::Result<Option<Value>> {
        self.initialize().await?;
        let Some(row) = sqlx::query(
            r#"
            SELECT record_json, last_read_message_seq
            FROM conversation_participants
            WHERE conversation_id = ? AND user_id = ? AND status = 'active'
            LIMIT 1
            "#,
        )
        .bind(conversation_id)
        .bind(user_id)
        .fetch_optional(&self.pool)
        .await?
        else {
            return Ok(None);
        };

        let latest_seq = self
            .latest_conversation_message_seq(conversation_id)
            .await?;
        let existing_seq = row.get::<i64, _>("last_read_message_seq");
        let read_seq = last_read_message_seq
            .max(0)
            .min(latest_seq)
            .max(existing_seq);
        let now = conversation_now_iso();
        let mut participant = json_from_text(row.get::<String, _>("record_json").as_str())?;
        if let Some(object) = participant.as_object_mut() {
            object.insert("last_read_message_seq".to_string(), json!(read_seq));
            object.insert("updated_at".to_string(), json!(now.clone()));
        }

        let Some(mut conversation) = self.get_conversation(conversation_id).await? else {
            return Ok(None);
        };
        if let Some(participants) = conversation
            .get_mut("participants")
            .and_then(Value::as_array_mut)
        {
            for item in participants {
                if item.get("user_id").and_then(Value::as_str) == Some(user_id) {
                    *item = participant.clone();
                    break;
                }
            }
        }

        let mut tx = self.pool.begin().await?;
        sqlx::query(
            r#"
            UPDATE conversation_participants
            SET last_read_message_seq = ?, updated_at = ?, record_json = ?
            WHERE conversation_id = ? AND user_id = ? AND status = 'active'
            "#,
        )
        .bind(read_seq)
        .bind(&now)
        .bind(json_text(&participant)?)
        .bind(conversation_id)
        .bind(user_id)
        .execute(&mut *tx)
        .await?;

        sqlx::query(
            r#"
            UPDATE conversations
            SET record_json = ?
            WHERE conversation_id = ?
            "#,
        )
        .bind(json_text(&conversation)?)
        .bind(conversation_id)
        .execute(&mut *tx)
        .await?;
        tx.commit().await?;
        Ok(Some(participant))
    }

    async fn get_direct_conversation_by_key(
        &self,
        direct_key: &str,
    ) -> anyhow::Result<Option<Value>> {
        sqlx::query(
            r#"
            SELECT record_json FROM conversations
            WHERE kind = 'direct' AND direct_key = ?
            "#,
        )
        .bind(direct_key)
        .fetch_optional(&self.pool)
        .await?
        .map(|row| json_from_text(row.get::<String, _>("record_json").as_str()))
        .transpose()
    }

    async fn get_conversation(&self, conversation_id: &str) -> anyhow::Result<Option<Value>> {
        sqlx::query(
            r#"
            SELECT record_json FROM conversations
            WHERE conversation_id = ?
            "#,
        )
        .bind(conversation_id)
        .fetch_optional(&self.pool)
        .await?
        .map(|row| json_from_text(row.get::<String, _>("record_json").as_str()))
        .transpose()
    }

    async fn conversation_has_participant(
        &self,
        conversation_id: &str,
        user_id: &str,
    ) -> anyhow::Result<bool> {
        let row = sqlx::query(
            r#"
            SELECT 1 FROM conversation_participants
            WHERE conversation_id = ? AND user_id = ? AND status = 'active'
            LIMIT 1
            "#,
        )
        .bind(conversation_id)
        .bind(user_id)
        .fetch_optional(&self.pool)
        .await?;
        Ok(row.is_some())
    }

    async fn touch_conversation_after_message(
        &self,
        conversation_id: &str,
        last_message_at: &str,
    ) -> anyhow::Result<()> {
        let Some(mut record) = self.get_conversation(conversation_id).await? else {
            return Ok(());
        };
        if let Some(object) = record.as_object_mut() {
            object.insert("updated_at".to_string(), json!(last_message_at));
            object.insert("last_message_at".to_string(), json!(last_message_at));
        }
        sqlx::query(
            r#"
            UPDATE conversations
            SET updated_at = ?, last_message_at = ?, record_json = ?
            WHERE conversation_id = ?
            "#,
        )
        .bind(last_message_at)
        .bind(last_message_at)
        .bind(json_text(&record)?)
        .bind(conversation_id)
        .execute(&self.pool)
        .await?;
        Ok(())
    }
}

fn direct_conversation_key(first_user_id: &str, second_user_id: &str) -> String {
    if first_user_id <= second_user_id {
        format!("{first_user_id}:{second_user_id}")
    } else {
        format!("{second_user_id}:{first_user_id}")
    }
}

fn direct_participants(
    conversation_id: &str,
    first_user_id: &str,
    second_user_id: &str,
    now: &str,
) -> Vec<Value> {
    [first_user_id, second_user_id]
        .into_iter()
        .map(|user_id| {
            json!({
                "conversation_id": conversation_id,
                "actor_type": "user",
                "actor_id": user_id,
                "user_id": user_id,
                "role": "member",
                "status": "active",
                "last_read_message_seq": 0,
                "created_at": now,
                "updated_at": now
            })
        })
        .collect()
}

fn conversation_now_iso() -> String {
    time::OffsetDateTime::now_utc()
        .format(&time::format_description::well_known::Rfc3339)
        .unwrap_or_else(|_| "1970-01-01T00:00:00Z".to_string())
}
