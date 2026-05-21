use std::io::Cursor;

use axum::body::Body;
use axum::extract::Query;
use axum::http::{header, HeaderValue, Response, StatusCode};
use image::{DynamicImage, ImageFormat, Luma};
use qrcode::QrCode;
use serde::Deserialize;

use crate::api::ApiError;

#[derive(Debug, Deserialize)]
pub struct QrcodeQuery {
    content: String,
}

pub async fn qrcode_png(Query(query): Query<QrcodeQuery>) -> Result<Response<Body>, ApiError> {
    let content = query.content.trim();
    if content.is_empty() || content.len() > 2048 {
        return Err(ApiError::bad_request("content must be 1 to 2048 bytes"));
    }
    let code = QrCode::new(content.as_bytes())
        .map_err(|err| ApiError::bad_request(format!("QR encode failed: {err}")))?;
    let image = code
        .render::<Luma<u8>>()
        .quiet_zone(true)
        .module_dimensions(8, 8)
        .build();
    let mut cursor = Cursor::new(Vec::new());
    DynamicImage::ImageLuma8(image)
        .write_to(&mut cursor, ImageFormat::Png)
        .map_err(|err| ApiError::new(StatusCode::INTERNAL_SERVER_ERROR, err.to_string()))?;

    let mut response = Response::new(Body::from(cursor.into_inner()));
    response
        .headers_mut()
        .insert(header::CONTENT_TYPE, HeaderValue::from_static("image/png"));
    response.headers_mut().insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static("public, max-age=60"),
    );
    Ok(response)
}
