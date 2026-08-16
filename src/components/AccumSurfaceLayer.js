import maplibregl from 'maplibre-gl';

export const ACCUM_SURFACE_LAYER_ID = 'accum-smooth-surface';

const inverseMercatorY = (value) =>
  (Math.atan(Math.sinh(Math.PI * (1 - 2 * value))) * 180) / Math.PI;

const rainfallHeight = (value) =>
  value < 0.1 ? 0 : Math.min(130000, Math.max(1800, Math.pow(value, 0.68) * 2600));

const rainfallColor = (value, palette) => {
  if (value <= palette[0].min) return palette[0].color;
  for (let index = 1; index < palette.length; index++) {
    const previous = palette[index - 1];
    const next = palette[index];
    if (value > next.min) continue;
    const blend = (value - previous.min) / (next.min - previous.min);
    return previous.color.map((channel, channelIndex) =>
      channel + (next.color[channelIndex] - channel) * blend,
    );
  }
  return palette.at(-1).color;
};

const compileShader = (gl, type, source) => {
  const shader = gl.createShader(type);
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    throw new Error(gl.getShaderInfoLog(shader) || 'Accumulated-rainfall shader compile failed.');
  }
  return shader;
};

export const createAccumSurfaceLayer = (palette) => ({
  id: ACCUM_SURFACE_LAYER_ID,
  type: 'custom',
  renderingMode: '3d',
  visible: false,
  shaderMap: new Map(),
  pendingGrid: null,
  meshKey: '',
  // 해안 경계 벽(스커트)용 지면 사본 정점 → 원본 격자 정점 index. 메쉬와 함께 갱신된다.
  rimSource: null,

  getShader(gl, shaderDescription) {
    if (this.shaderMap.has(shaderDescription.variantName)) {
      return this.shaderMap.get(shaderDescription.variantName);
    }
    const vertexSource = `#version 300 es
      ${shaderDescription.vertexShaderPrelude}
      ${shaderDescription.define}
      in vec2 aPos;
      in float aZScale;
      in vec4 aSurface; // x: height(m), y: rainfall(mm), z: lighting
      in vec3 aColor;
      out float vValue;
      out float vShade;
      out vec3 vColor;
      void main() {
        vValue = aSurface.y;
        vShade = aSurface.z;
        vColor = aColor;
        #ifdef GLOBE
          float elevation = aSurface.x;
        #else
          float elevation = aSurface.x * aZScale;
        #endif
        gl_Position = projectTileWithElevation(aPos, elevation);
      }`;
    const fragmentSource = `#version 300 es
      precision mediump float;
      in float vValue;
      in float vShade;
      in vec3 vColor;
      out vec4 fragColor;
      void main() {
        float alpha = smoothstep(0.08, 0.28, vValue);
        if (alpha < 0.01) discard;
        vec3 color = clamp(vColor * vShade, 0.0, 1.0);
        fragColor = vec4(color * alpha, alpha);
      }`;
    const program = gl.createProgram();
    gl.attachShader(program, compileShader(gl, gl.VERTEX_SHADER, vertexSource));
    gl.attachShader(program, compileShader(gl, gl.FRAGMENT_SHADER, fragmentSource));
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      throw new Error(gl.getProgramInfoLog(program) || 'Accumulated-rainfall shader link failed.');
    }
    const shader = {
      program,
      aPos: gl.getAttribLocation(program, 'aPos'),
      aZScale: gl.getAttribLocation(program, 'aZScale'),
      aSurface: gl.getAttribLocation(program, 'aSurface'),
      aColor: gl.getAttribLocation(program, 'aColor'),
      uProjMatrix: gl.getUniformLocation(program, 'u_projection_matrix'),
      uFallbackMatrix: gl.getUniformLocation(program, 'u_projection_fallback_matrix'),
      uTileMercatorCoords: gl.getUniformLocation(program, 'u_projection_tile_mercator_coords'),
      uClippingPlane: gl.getUniformLocation(program, 'u_projection_clipping_plane'),
      uTransition: gl.getUniformLocation(program, 'u_projection_transition'),
    };
    this.shaderMap.set(shaderDescription.variantName, shader);
    return shader;
  },

  onAdd(map, gl) {
    this.map = map;
    this.gl = gl;
    this.positionBuffer = gl.createBuffer();
    this.zScaleBuffer = gl.createBuffer();
    this.surfaceBuffer = gl.createBuffer();
    this.colorBuffer = gl.createBuffer();
    this.indexBuffer = gl.createBuffer();
    if (this.pendingGrid) this.uploadGrid(this.pendingGrid);
  },

  setVisible(visible) {
    this.visible = visible;
    this.map?.triggerRepaint();
  },

  clear() {
    this.pendingGrid = null;
    this.map?.triggerRepaint();
  },

  setGrid(grid) {
    this.pendingGrid = grid;
    if (this.gl) this.uploadGrid(grid);
  },

  uploadGrid(grid) {
    const gl = this.gl;
    const {
      width,
      height,
      values,
      valid,
      sampleOffset,
      stride,
      latticeWidth,
      latticeHeight,
      bounds,
    } = grid;
    const nextMeshKey = `${width}:${height}:${sampleOffset}:${stride}:${latticeWidth}:${latticeHeight}`;

    const gridVertexCount = width * height;

    if (this.meshKey !== nextMeshKey) {
      const basePositions = new Float32Array(gridVertexCount * 2);
      const baseZScales = new Float32Array(gridVertexCount);
      const yTop = maplibregl.MercatorCoordinate.fromLngLat(
        { lng: bounds.lonMin, lat: bounds.latMax },
        0,
      ).y;
      const yBottom = maplibregl.MercatorCoordinate.fromLngLat(
        { lng: bounds.lonMin, lat: bounds.latMin },
        0,
      ).y;
      for (let gridY = 0; gridY < height; gridY++) {
        for (let gridX = 0; gridX < width; gridX++) {
          const index = gridY * width + gridX;
          const latticeX = sampleOffset + gridX * stride;
          const latticeY = sampleOffset + gridY * stride;
          const lon =
            bounds.lonMin +
            (latticeX / latticeWidth) * (bounds.lonMax - bounds.lonMin);
          const mercatorY = yTop + (latticeY / latticeHeight) * (yBottom - yTop);
          const lat = inverseMercatorY(mercatorY);
          const coordinate = maplibregl.MercatorCoordinate.fromLngLat({ lng: lon, lat }, 0);
          basePositions[index * 2] = coordinate.x;
          basePositions[index * 2 + 1] = coordinate.y;
          baseZScales[index] = maplibregl.MercatorCoordinate.fromLngLat({ lng: lon, lat }, 1).z;
        }
      }
      const indices = [];
      const isDrawnQuad = (quadX, quadY) => {
        if (quadX < 0 || quadY < 0 || quadX >= width - 1 || quadY >= height - 1) return false;
        const topLeft = quadY * width + quadX;
        return Boolean(
          valid[topLeft] && valid[topLeft + 1] && valid[topLeft + width] && valid[topLeft + width + 1],
        );
      };

      // 육지 경계에서 윗면이 뚝 끊기면 옆이 뚫려 바닥 지도가 비쳐 보인다. 경계에
      // 닿은 정점만 '지면 사본'(같은 위치, 높이 0)을 추가로 만들어 수직 벽을 세운다.
      // 전 정점을 복제하지 않으므로 늘어나는 정점은 해안선 길이에 비례할 뿐이다.
      const rimSourceList = [];
      const rimIndexOf = new Map();
      const groundVertex = (vertex) => {
        let rim = rimIndexOf.get(vertex);
        if (rim === undefined) {
          rim = gridVertexCount + rimSourceList.length;
          rimIndexOf.set(vertex, rim);
          rimSourceList.push(vertex);
        }
        return rim;
      };
      // 바깥에서 봤을 때 앞면이 되도록 감는다(양면 렌더라 뒤집혀도 보이긴 한다).
      const pushWall = (near, far) => {
        const nearGround = groundVertex(near);
        const farGround = groundVertex(far);
        indices.push(near, far, nearGround);
        indices.push(far, farGround, nearGround);
      };

      for (let gridY = 0; gridY < height - 1; gridY++) {
        for (let gridX = 0; gridX < width - 1; gridX++) {
          const topLeft = gridY * width + gridX;
          const topRight = topLeft + 1;
          const bottomLeft = topLeft + width;
          const bottomRight = bottomLeft + 1;
          if (!isDrawnQuad(gridX, gridY)) {
            continue;
          }
          indices.push(topLeft, topRight, bottomLeft, topRight, bottomRight, bottomLeft);
          // 이웃 칸이 없는 쪽(=육지 경계)에만 벽을 세운다.
          if (!isDrawnQuad(gridX, gridY - 1)) pushWall(topRight, topLeft);
          if (!isDrawnQuad(gridX, gridY + 1)) pushWall(bottomLeft, bottomRight);
          if (!isDrawnQuad(gridX - 1, gridY)) pushWall(topLeft, bottomLeft);
          if (!isDrawnQuad(gridX + 1, gridY)) pushWall(bottomRight, topRight);
        }
      }

      const rimSource = new Int32Array(rimSourceList);
      const totalVertexCount = gridVertexCount + rimSource.length;
      const positions = new Float32Array(totalVertexCount * 2);
      const zScales = new Float32Array(totalVertexCount);
      positions.set(basePositions);
      zScales.set(baseZScales);
      // 지면 사본은 위치·축척이 원본과 같고 높이만 0이 된다(아래 surface 채우기 참조).
      for (let rim = 0; rim < rimSource.length; rim++) {
        const source = rimSource[rim];
        const target = gridVertexCount + rim;
        positions[target * 2] = basePositions[source * 2];
        positions[target * 2 + 1] = basePositions[source * 2 + 1];
        zScales[target] = baseZScales[source];
      }

      const indexArray = new Uint32Array(indices);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.positionBuffer);
      gl.bufferData(gl.ARRAY_BUFFER, positions, gl.STATIC_DRAW);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.zScaleBuffer);
      gl.bufferData(gl.ARRAY_BUFFER, zScales, gl.STATIC_DRAW);
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.indexBuffer);
      gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, indexArray, gl.STATIC_DRAW);
      this.indexCount = indexArray.length;
      this.rimSource = rimSource;
      this.meshKey = nextMeshKey;
    }

    const rimSource = this.rimSource ?? new Int32Array(0);
    const totalVertexCount = gridVertexCount + rimSource.length;
    const surface = new Float32Array(totalVertexCount * 4);
    const colors = new Float32Array(totalVertexCount * 3);
    const heights = new Float32Array(gridVertexCount);
    for (let index = 0; index < values.length; index++) {
      heights[index] = rainfallHeight(Math.max(0, values[index]));
    }
    for (let gridY = 0; gridY < height; gridY++) {
      for (let gridX = 0; gridX < width; gridX++) {
        const index = gridY * width + gridX;
        const value = Math.max(0, values[index]);
        const northwest =
          heights[Math.max(0, gridY - 1) * width + Math.max(0, gridX - 1)];
        const shade = Math.min(1.14, Math.max(0.76, 1 + (heights[index] - northwest) * 0.000003));
        const color = rainfallColor(value, palette);
        surface[index * 4] = heights[index];
        surface[index * 4 + 1] = value;
        surface[index * 4 + 2] = shade;
        colors[index * 3] = color[0] / 255;
        colors[index * 3 + 1] = color[1] / 255;
        colors[index * 3 + 2] = color[2] / 255;
      }
    }
    // 지면 사본: 높이만 0으로 낮춘다. 값(=불투명도)과 색은 원본과 같아야 벽이 윗면과
    // 이어져 보인다. 음영만 낮춰 옆면이 윗면과 구분되게 한다.
    for (let rim = 0; rim < rimSource.length; rim++) {
      const source = rimSource[rim];
      const target = gridVertexCount + rim;
      surface[target * 4] = 0;
      surface[target * 4 + 1] = surface[source * 4 + 1];
      surface[target * 4 + 2] = surface[source * 4 + 2] * 0.72;
      colors[target * 3] = colors[source * 3];
      colors[target * 3 + 1] = colors[source * 3 + 1];
      colors[target * 3 + 2] = colors[source * 3 + 2];
    }
    gl.bindBuffer(gl.ARRAY_BUFFER, this.surfaceBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, surface, gl.DYNAMIC_DRAW);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.colorBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, colors, gl.DYNAMIC_DRAW);
    this.map?.triggerRepaint();
  },

  render(gl, renderArgs) {
    if (!this.visible || !this.indexCount) return;
    const projectionData = renderArgs?.defaultProjectionData;
    if (!projectionData) return;
    const shader = this.getShader(gl, renderArgs.shaderData);
    gl.useProgram(shader.program);
    gl.uniformMatrix4fv(shader.uProjMatrix, false, projectionData.mainMatrix);
    gl.uniformMatrix4fv(shader.uFallbackMatrix, false, projectionData.fallbackMatrix);
    gl.uniform4f(shader.uTileMercatorCoords, ...projectionData.tileMercatorCoords);
    gl.uniform4f(shader.uClippingPlane, ...projectionData.clippingPlane);
    gl.uniform1f(shader.uTransition, projectionData.projectionTransition);

    gl.bindBuffer(gl.ARRAY_BUFFER, this.positionBuffer);
    gl.enableVertexAttribArray(shader.aPos);
    gl.vertexAttribPointer(shader.aPos, 2, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.zScaleBuffer);
    gl.enableVertexAttribArray(shader.aZScale);
    gl.vertexAttribPointer(shader.aZScale, 1, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.surfaceBuffer);
    gl.enableVertexAttribArray(shader.aSurface);
    gl.vertexAttribPointer(shader.aSurface, 4, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.colorBuffer);
    gl.enableVertexAttribArray(shader.aColor);
    gl.vertexAttribPointer(shader.aColor, 3, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.indexBuffer);
    gl.enable(gl.DEPTH_TEST);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.drawElements(gl.TRIANGLES, this.indexCount, gl.UNSIGNED_INT, 0);
  },

  onRemove(_map, gl) {
    [
      this.positionBuffer,
      this.zScaleBuffer,
      this.surfaceBuffer,
      this.colorBuffer,
      this.indexBuffer,
    ].forEach((buffer) => buffer && gl.deleteBuffer(buffer));
    this.shaderMap.forEach(({ program }) => gl.deleteProgram(program));
    this.gl = null;
    this.map = null;
  },
});
