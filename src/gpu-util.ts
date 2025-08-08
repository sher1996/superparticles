// WebGPU utility functions for adapter and device management

let cachedAdapter: GPUAdapter | null = null;
let cachedDevice: GPUDevice | null = null;

/**
 * Get a WebGPU adapter with fallback support
 */
export async function getAdapter(): Promise<GPUAdapter | null> {
  if (cachedAdapter) {
    return cachedAdapter;
  }

  if (!navigator.gpu) {
    console.error('WebGPU not supported');
    return null;
  }

  try {
    // Try to get the best adapter
    cachedAdapter = await navigator.gpu.requestAdapter({
      powerPreference: 'high-performance',
    });

    if (!cachedAdapter) {
      // Fallback to any available adapter
      cachedAdapter = await navigator.gpu.requestAdapter();
    }

    return cachedAdapter;
  } catch (error) {
    console.error('Failed to get WebGPU adapter:', error);
    return null;
  }
}

/**
 * Get a WebGPU device with error handling
 */
export async function getDevice(): Promise<GPUDevice | null> {
  if (cachedDevice) {
    return cachedDevice;
  }

  const adapter = await getAdapter();
  if (!adapter) {
    return null;
  }

  try {
    cachedDevice = await adapter.requestDevice({
      requiredFeatures: [
        'shader-f16',
        'uniform-buffer-array-non-uniform-indexing',
      ],
      requiredLimits: {
        maxStorageBufferBindingSize: 1024 * 1024 * 1024, // 1GB
        maxBufferSize: 1024 * 1024 * 1024, // 1GB
        maxComputeWorkgroupSizeX: 64,
        maxComputeWorkgroupSizeY: 64,
        maxComputeWorkgroupSizeZ: 64,
        maxComputeWorkgroupsPerDimension: 65535,
      },
    });

    return cachedDevice;
  } catch (error) {
    console.error('Failed to get WebGPU device:', error);
    return null;
  }
}

/**
 * Create a GPU buffer with the specified data and usage
 */
export function createBuffer(
  device: GPUDevice,
  data: ArrayBufferView,
  usage: GPUBufferUsageFlags
): GPUBuffer {
  const buffer = device.createBuffer({
    size: data.byteLength,
    usage: usage | GPUBufferUsage.COPY_DST,
  });

  device.queue.writeBuffer(buffer, 0, data);
  return buffer;
}

/**
 * Create a staging buffer for data transfer
 */
export function createStagingBuffer(
  device: GPUDevice,
  size: number
): GPUBuffer {
  return device.createBuffer({
    size,
    usage: GPUBufferUsage.MAP_WRITE | GPUBufferUsage.COPY_SRC,
  });
}

/**
 * Copy data from a staging buffer to a destination buffer
 */
export async function copyBuffer(
  device: GPUDevice,
  stagingBuffer: GPUBuffer,
  destinationBuffer: GPUBuffer,
  size: number
): Promise<void> {
  const commandEncoder = device.createCommandEncoder();
  commandEncoder.copyBufferToBuffer(stagingBuffer, 0, destinationBuffer, 0, size);
  device.queue.submit([commandEncoder.finish()]);
}

/**
 * Check if WebGPU is supported in the current environment
 */
export function isWebGPUSupported(): boolean {
  return !!(navigator.gpu && navigator.gpu.requestAdapter);
}

/**
 * Get device capabilities and limits
 */
export async function getDeviceInfo(): Promise<{
  adapter: string;
  device: string;
  features: string[];
  limits: Record<string, number>;
} | null> {
  const device = await getDevice();
  if (!device) return null;

  const adapter = cachedAdapter;
  if (!adapter) return null;

  return {
    adapter: adapter.name || 'Unknown',
    device: device.label || 'Unknown',
    features: Array.from(device.features),
    limits: device.limits,
  };
}

/**
 * Clean up cached resources
 */
export function dispose(): void {
  cachedAdapter = null;
  cachedDevice = null;
} 